import test from 'node:test';
import assert from 'node:assert/strict';
import {LabStore} from '../lib/store.js';
import {runTick} from '../lib/engine.js';
import {CADENCE_MS,LEASE_MS,PipelineError,stableId} from '../lib/safety.js';
import {readDictionary} from '../lib/dictionary.js';
import {testEnv,readyEnv,TEST_NOW,TEST_PROVIDER,fixtureSources,wikiPage,wikiJson,word,providerXml,providerRow} from './helpers.mjs';

test('scheduler stays paused/disabled and performs no external requests by default',async()=>{
  const env=testEnv();let calls=0;const fetcher=async()=>{calls++;throw Error('must not call')};
  assert.equal((await runTick(env,{clock:()=>TEST_NOW,fetcher})).status,'paused_busy_or_not_due');
  env.SCHEDULER_ENABLED='false';assert.equal((await runTick(env,{clock:()=>TEST_NOW,fetcher})).status,'scheduler_disabled');assert.equal(calls,0);env.DB.close();
});
test('a real SQLite lease permits exactly one concurrent runner',async()=>{
  const env=await readyEnv();const store=new LabStore(env.DB);
  const results=await Promise.all(Array.from({length:12},()=>store.acquire(TEST_NOW,'test')));
  assert.equal(results.filter(Boolean).length,1);env.DB.close();
});
test('discovery runs Nepali then English, keeps exact provenance and idempotent jobs',async()=>{
  const env=await readyEnv();const store=new LabStore(env.DB),source=fixtureSources({next:'next-page'});
  const result=await runTick(env,{clock:()=>TEST_NOW,fetcher:source.fetcher,random:()=>0});
  assert.equal(result.status,'completed');assert.equal(result.completed,2);
  assert.equal(new URL(source.calls[0].url).hostname,'ne.wiktionary.org');assert.equal(source.calls.length,2);
  const words=await store.all('SELECT * FROM words ORDER BY domain');assert.deepEqual(words.map(w=>w.domain),['arna.com','tree.com']);
  const arna=await store.stmt("SELECT * FROM meanings WHERE domain='arna.com'").first();assert.equal(arna.review_actor,'automated_rule');assert.equal(arna.romanization_status,'rule_reviewed_practical');assert.equal(arna.definition_status,'dictionary_definition_verified');
  assert(arna.revision_url.includes('?oldid='));assert(arna.license.includes('CC-BY-SA'));
  assert.equal((await store.control()).last_scheduled_at,null);
  await runTick(env,{clock:()=>TEST_NOW,fetcher:source.fetcher});assert.equal(source.calls.length,2);
  assert.equal((await store.stmt('SELECT COUNT(*) AS n FROM jobs').first()).n,2);env.DB.close();
});
test('uncertain romanizations retain verified source definitions but stay outside candidate queue',async()=>{
  const env=await readyEnv();const source=fixtureSources({nepali:[wikiPage('अम्बक','==नेपाली==\n===अर्थ===\n# अम्बा वा बेलौती',1),wikiPage('वकालत','==नेपाली==\n===अर्थ===\n# पक्षमा तर्क वा वकालत गर्ने काम',3)],english:[]});
  await runTick(env,{clock:()=>TEST_NOW,fetcher:source.fetcher});const store=new LabStore(env.DB);
  const reviews=await store.all('SELECT * FROM reviews');assert.equal(reviews.length,2);assert(reviews.every(r=>r.decision==='pending'&&r.definition_status==='dictionary_definition_verified'));
  assert.equal((await store.stmt('SELECT COUNT(*) AS n FROM words').first()).n,0);env.DB.close();
});
test('cursor progression and repeated source revisions do not duplicate names or jobs',async()=>{
  const env=await readyEnv();const store=new LabStore(env.DB),source=fixtureSources({next:'next-page'});
  await runTick(env,{clock:()=>TEST_NOW,fetcher:source.fetcher});
  const second=fixtureSources();await runTick(env,{clock:()=>TEST_NOW+CADENCE_MS,fetcher:second.fetcher});
  assert(second.calls.every(c=>new URL(c.url).searchParams.get('gapcontinue')==='next-page'));
  assert.equal((await store.stmt('SELECT COUNT(*) AS n FROM dictionary_entries').first()).n,2);
  assert.equal((await store.stmt('SELECT COUNT(*) AS n FROM words').first()).n,2);
  assert.equal((await store.stmt('SELECT COUNT(*) AS n FROM jobs').first()).n,4);env.DB.close();
});
test('multilingual source collisions preserve both meanings and canonical language',async()=>{
  const env=await readyEnv();const store=new LabStore(env.DB);await word(store,'arna.com','English');
  const source=fixtureSources({english:[wikiPage('arna','==English==\n# A synthetic English sense for collision testing.',9)]});
  await runTick(env,{clock:()=>TEST_NOW,fetcher:source.fetcher});
  const canonical=await store.stmt("SELECT * FROM words WHERE domain='arna.com'").first();assert.equal(canonical.language,'English');
  const meanings=await store.all("SELECT * FROM meanings WHERE domain='arna.com'");assert.deepEqual(meanings.map(m=>m.language).sort(),['English','Nepali']);assert.notEqual(meanings[0].definition,meanings[1].definition);env.DB.close();
});
test('retry-after is persisted and another healthy source can finish independently',async()=>{
  const env=await readyEnv();const store=new LabStore(env.DB);let neCalls=0;
  const fetcher=async url=>new URL(url).hostname==='ne.wiktionary.org'?(neCalls++,new Response('',{status:429,headers:{'Retry-After':'3600'}})):wikiJson([wikiPage('tree','==English==\n# A woody plant.',2)]);
  const result=await runTick(env,{clock:()=>TEST_NOW,fetcher,random:()=>0});assert.equal(result.status,'partial');assert.equal(result.completed,1);
  const retry=await store.stmt("SELECT * FROM jobs WHERE source='nepali'").first();assert.equal(retry.status,'retry');assert.equal(retry.not_before,TEST_NOW+3600000);
  await runTick(env,{clock:()=>TEST_NOW+CADENCE_MS,fetcher,random:()=>0});assert.equal(neCalls,1);env.DB.close();
});
test('403 denial blocks that source without alternate routes or automatic retries',async()=>{
  const env=await readyEnv();const store=new LabStore(env.DB);let calls=0;
  const fetcher=async url=>new URL(url).hostname==='ne.wiktionary.org'?(calls++,new Response('',{status:403})):wikiJson([]);
  await runTick(env,{clock:()=>TEST_NOW,fetcher});await runTick(env,{clock:()=>TEST_NOW+CADENCE_MS,fetcher});
  assert.equal(calls,1);assert.equal((await store.stmt("SELECT status FROM source_health WHERE source='nepali'").first()).status,'denied');
  assert.equal((await store.stmt("SELECT status FROM jobs WHERE source='nepali'").first()).status,'blocked');env.DB.close();
});
test('bounded retries eventually fail and remain observable',async()=>{
  const env=await readyEnv();const store=new LabStore(env.DB);const fetcher=async()=>new Response('',{status:503});
  for(const offset of [0,240000,720000,1680000])await runTick(env,{clock:()=>TEST_NOW+offset,fetcher,random:()=>0});
  const jobs=await store.all('SELECT * FROM jobs');assert(jobs.every(j=>j.status==='failed'&&j.attempts===3));assert((await store.all("SELECT * FROM job_events WHERE action='failed'")).length===2);env.DB.close();
});
test('crash recovery reclaims expired jobs and fences out the previous worker',async()=>{
  const env=await readyEnv();const store=new LabStore(env.DB);
  const old=await store.acquire(TEST_NOW,'test');await store.enqueue(old,TEST_NOW,false);const job=await store.claim(old,TEST_NOW,false);
  const batch=await readDictionary('nepali','',{now:TEST_NOW,fetcher:fixtureSources().fetcher});
  const next=await store.acquire(TEST_NOW+CADENCE_MS,'test');assert(next);assert.equal((await store.stmt('SELECT status FROM jobs WHERE id=?',job.id).first()).status,'retry');
  await store.commitDictionary(job,batch,old,TEST_NOW+CADENCE_MS);
  assert.equal((await store.stmt('SELECT COUNT(*) AS n FROM words').first()).n,0);
  assert.equal((await store.all("SELECT * FROM job_events WHERE action='recovered'")).length,1);
  const recovered=await store.claim(next,TEST_NOW+CADENCE_MS,false);assert.equal(recovered.id,job.id);assert.equal(recovered.attempts,2);env.DB.close();
});
test('pause invalidates an in-flight execution and resume safely recovers its job',async()=>{
  const env=await readyEnv();const store=new LabStore(env.DB);const lease=await store.acquire(TEST_NOW,'test');
  await store.enqueue(lease,TEST_NOW,false);const job=await store.claim(lease,TEST_NOW,false);
  const batch=await readDictionary('nepali','',{now:TEST_NOW,fetcher:fixtureSources().fetcher});
  await store.setPaused(true,TEST_NOW+1);await store.commitDictionary(job,batch,lease,TEST_NOW+2);
  assert.equal((await store.stmt('SELECT COUNT(*) AS n FROM words').first()).n,0);
  assert.equal((await store.stmt('SELECT status FROM jobs WHERE id=?',job.id).first()).status,'retry');
  await store.setPaused(false,TEST_NOW+3);assert(await store.acquire(TEST_NOW+3,'test'));env.DB.close();
});
test('cancelling an in-flight job discards late network results',async()=>{
  const env=await readyEnv();const store=new LabStore(env.DB);const lease=await store.acquire(TEST_NOW,'test');
  await store.enqueue(lease,TEST_NOW,false);const job=await store.claim(lease,TEST_NOW,false);
  const batch=await readDictionary('nepali','',{now:TEST_NOW,fetcher:fixtureSources().fetcher});
  assert(await store.cancelJob(job.id,TEST_NOW+1));await store.commitDictionary(job,batch,lease,TEST_NOW+2);
  assert.equal((await store.stmt('SELECT COUNT(*) AS n FROM words').first()).n,0);
  assert.equal((await store.stmt('SELECT status FROM jobs WHERE id=?',job.id).first()).status,'cancelled');env.DB.close();
});
test('active manual leases and historical words are excluded from automatic availability jobs',async()=>{
  const env=await readyEnv(TEST_PROVIDER);const store=new LabStore(env.DB);await word(store,'past.com');
  const source=fixtureSources();await runTick(env,{clock:()=>TEST_NOW,fetcher:source.fetcher});
  await store.stmt('UPDATE engine_control SET availability_enabled=1').run();
  await store.stmt('INSERT INTO leases VALUES(?,?,?)','tree.com','manual-review',new Date(TEST_NOW+3600000).toISOString()).run();
  const lease=await store.acquire(TEST_NOW+CADENCE_MS,'test');await store.enqueue(lease,TEST_NOW+CADENCE_MS,true);
  const jobs=await store.all("SELECT * FROM jobs WHERE kind='availability'");assert.equal(jobs.length,1);assert.deepEqual(JSON.parse(jobs[0].payload).domains,['arna.com']);env.DB.close();
});
test('partial official results are committed once and only missing domains are retried',async()=>{
  const env=await readyEnv(TEST_PROVIDER);const store=new LabStore(env.DB);
  await runTick(env,{clock:()=>TEST_NOW,fetcher:fixtureSources().fetcher});await store.stmt('UPDATE engine_control SET availability_enabled=1').run();
  const calls=[];const fetcher=async url=>{const u=new URL(url);calls.push(u.searchParams.get('DomainList'));return new Response(providerXml(providerRow('arna.com')))};
  await runTick(env,{clock:()=>TEST_NOW+CADENCE_MS,fetcher,random:()=>0});
  const job=await store.stmt("SELECT * FROM jobs WHERE kind='availability'").first();assert.equal(job.status,'retry');assert.deepEqual(JSON.parse(job.payload).domains,['tree.com']);
  assert.equal((await store.stmt("SELECT status FROM observations WHERE domain='arna.com'").first()).status,'standard_offer');
  assert.equal(await store.stmt("SELECT status FROM observations WHERE domain='tree.com'").first(),null);
  const complete=async url=>{calls.push(new URL(url).searchParams.get('DomainList'));return new Response(providerXml(providerRow('tree.com')))};
  await runTick(env,{clock:()=>TEST_NOW+2*CADENCE_MS,fetcher:complete,random:()=>0});
  assert.deepEqual(calls,['arna.com,tree.com','tree.com']);assert.equal((await store.stmt('SELECT COUNT(*) AS n FROM availability_events').first()).n,3);
  assert.equal((await store.stmt('SELECT status FROM jobs WHERE id=?',job.id).first()).status,'succeeded');env.DB.close();
});
test('run time budget stops before starting another bounded upstream request',async()=>{
  const env=await readyEnv();let time=TEST_NOW,calls=0;
  const source=fixtureSources();const fetcher=async(url,options)=>{calls++;time+=18000;return source.fetcher(url,options)};
  await runTick(env,{clock:()=>time,fetcher});assert.equal(calls,1);env.DB.close();
});
