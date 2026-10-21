import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorker} from '../worker.js';
import {LabStore} from '../lib/store.js';
import {testEnv,TEST_NOW,apiRequest,acceptedWord as word} from './helpers.mjs';

test('manual reservation is private, origin checked and bounded to 1–20 names',async()=>{
  const env=testEnv(),app=createWorker({clock:()=>TEST_NOW});const request_id=crypto.randomUUID();
  assert.equal((await app.fetch(apiRequest('next-batch',{count:2,request_id}),{DB:env.DB})).status,503);
  assert.equal((await app.fetch(apiRequest('next-batch',{count:2,request_id},{Origin:'https://evil.test'}),env)).status,403);
  for(const count of [0,21,1.1,'2'])assert.equal((await app.fetch(apiRequest('next-batch',{count,request_id}),env)).status,400);
  assert.equal((await app.fetch(apiRequest('next-batch',{count:2}),env)).status,400);env.DB.close();
});
test('concurrent duplicate reservation requests return one batch and no extra leases',async()=>{
  const env=testEnv(),store=new LabStore(env.DB),app=createWorker({clock:()=>TEST_NOW});
  for(const name of ['tree.com','wood.com','lake.com','home.com'])await word(store,name);
  const request_id=crypto.randomUUID();const results=await Promise.all(Array.from({length:5},()=>app.fetch(apiRequest('next-batch',{count:2,request_id}),env).then(r=>r.json())));
  assert.equal(new Set(results.map(r=>r.batch_id)).size,1);assert(results.every(r=>r.words.length===2));
  assert.equal((await store.stmt('SELECT COUNT(*) AS n FROM leases').first()).n,2);assert.equal((await store.stmt('SELECT COUNT(*) AS n FROM manual_batches').first()).n,1);env.DB.close();
});
test('active batches resume through reads, avoid overlap, and release idempotently',async()=>{
  const env=testEnv(),store=new LabStore(env.DB),app=createWorker({clock:()=>TEST_NOW});for(const name of ['tree.com','wood.com','lake.com','home.com'])await word(store,name);
  const first=await(await app.fetch(apiRequest('next-batch',{count:2,request_id:crypto.randomUUID()}),env)).json();
  const second=await(await app.fetch(apiRequest('next-batch',{count:2,request_id:crypto.randomUUID()}),env)).json();
  assert(first.words.every(w=>!second.words.some(o=>o.domain===w.domain)));
  const readback=await(await app.fetch(apiRequest('batches'),env)).json();assert.equal(readback.batches.find(b=>b.id===first.batch_id).words.length,2);
  for(let i=0;i<2;i++)assert.equal((await app.fetch(apiRequest('batches/release',{batch_id:first.batch_id}),env)).status,200);
  const remaining=await store.all('SELECT * FROM leases');assert.equal(remaining.length,2);assert(remaining.every(l=>l.batch_id===second.batch_id));
  const released=(await store.batches(TEST_NOW)).find(b=>b.id===first.batch_id);assert.equal(released.state,'released');assert.equal(released.words.length,0);env.DB.close();
});
test('expired replay cannot reserve additional names, and releasing an old batch cannot touch a newer lease',async()=>{
  const env=testEnv(),store=new LabStore(env.DB);await word(store);const id=crypto.randomUUID();const first=await store.reserveBatch(1,id,TEST_NOW);
  const second=await store.reserveBatch(1,crypto.randomUUID(),TEST_NOW+13*60_000);assert.equal(second.words.length,1);
  const replay=await store.reserveBatch(1,id,TEST_NOW+13*60_000);assert.equal(replay.state,'expired');assert.equal(replay.words.length,0);
  await store.releaseBatch(first.batch_id,TEST_NOW+14*60_000);assert.equal((await store.stmt('SELECT batch_id FROM leases').first()).batch_id,second.batch_id);env.DB.close();
});

test('manual reservation excludes rejected sole meanings, legacy entries and blank accepted definitions',async()=>{
  const env=testEnv(),store=new LabStore(env.DB);
  await word(store,'arna.com','Nepali');await word(store,'tree.com');await word(store,'void.com');
  await store.stmt("UPDATE meanings SET accepted=0 WHERE domain='arna.com'").run();
  await store.stmt("UPDATE meanings SET definition='   ' WHERE domain='void.com'").run();
  await store.stmt("INSERT INTO words(domain,word,meaning,language,source,fetched) VALUES('past.com','past','Legacy text','English','https://en.wiktionary.org/wiki/past',?)",new Date(TEST_NOW).toISOString()).run();
  const batch=await store.reserveBatch(20,crypto.randomUUID(),TEST_NOW);assert.deepEqual(batch.words.map(w=>w.domain),['tree.com']);env.DB.close();
});
test('another accepted meaning preserves a domain eligibility after one meaning is rejected',async()=>{
  const env=testEnv(),store=new LabStore(env.DB);await word(store,'arna.com','Nepali');
  await store.stmt("UPDATE meanings SET accepted=0 WHERE domain='arna.com'").run();
  await store.stmt(`INSERT INTO meanings(id,domain,language,native,definition,romanization,romanization_status,entry_url,revision_url,retrieved_at,license,origin,accepted,first_seen_at)
    VALUES('other-sense','arna.com','English','','A second source-backed fixture sense','arna','dictionary_spelling','https://en.wiktionary.org/wiki/arna','https://en.wiktionary.org/wiki/arna?oldid=2',?,'Test fixture','test_fixture',1,?)`,new Date(TEST_NOW).toISOString(),new Date(TEST_NOW).toISOString()).run();
  assert.equal((await store.reserveBatch(1,crypto.randomUUID(),TEST_NOW)).words[0].domain,'arna.com');env.DB.close();
});
