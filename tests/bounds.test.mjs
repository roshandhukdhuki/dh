import test from 'node:test';
import assert from 'node:assert/strict';
import {LabStore} from '../lib/store.js';
import {runTick} from '../lib/engine.js';
import {TEST_NOW,TEST_PROVIDER,readyEnv,fixtureSources,wikiPage,wikiJson,providerXml,providerRow} from './helpers.mjs';

test('full bounded cron tick stays within the D1 Free 50-query invocation limit',async()=>{
  const env=await readyEnv(TEST_PROVIDER);const store=new LabStore(env.DB);
  await runTick(env,{clock:()=>TEST_NOW,fetcher:fixtureSources({next:'next-page'}).fetcher});
  await store.stmt('UPDATE engine_control SET availability_enabled=1').run();
  const english=['bark','wood','lake','rivers','homes','learning','camera','vision','guide','shelter'].map((name,i)=>wikiPage(name,'==English==\n# A synthetic natural scene for tests.',i+20));
  const nepali=Array.from({length:10},(_,i)=>wikiPage('काला','==नेपाली==\n===अर्थ===\n# कालो वर्ण भएको',i+100));
  let requests=0;
  const fetcher=async url=>{requests++;const u=new URL(url);return u.hostname==='api.namecheap.com'?new Response(providerXml(u.searchParams.get('DomainList').split(',').map(d=>providerRow(d)).join(''))):wikiJson(u.hostname==='ne.wiktionary.org'?nepali:english)};
  env.DB.queryCount=0;
  const result=await runTick(env,{trigger:'scheduled',clock:()=>TEST_NOW+240000,fetcher});
  const count=env.DB.queryCount;
  assert.equal(result.completed,3);assert.equal(requests,3);assert(count<=50,`Used ${count} SQL queries`);
  env.DB.close();
});
test('repeated pause/resume requests are idempotent and do not invalidate an active lease',async()=>{
  const env=await readyEnv(),store=new LabStore(env.DB);const lease=await store.acquire(TEST_NOW,'test');
  await store.setPaused(false,TEST_NOW+1);assert(await store.active(lease,TEST_NOW+1));
  await store.setPaused(true,TEST_NOW+2);const first=await store.control();await store.setPaused(true,TEST_NOW+3);
  assert.equal((await store.control()).epoch,first.epoch);env.DB.close();
});
test('manual imports, candidate rejection and new manual leases are rechecked before registrar dispatch',async()=>{
  const env=await readyEnv(TEST_PROVIDER),store=new LabStore(env.DB);
  await runTick(env,{clock:()=>TEST_NOW,fetcher:fixtureSources().fetcher});
  const lease=await store.acquire(TEST_NOW+240000,'test');await store.enqueue(lease,TEST_NOW+240000,true);
  await store.release(lease,TEST_NOW+240000,0);
  await store.stmt("UPDATE words SET triage='rejected' WHERE domain='arna.com'").run();
  await store.stmt("INSERT INTO leases VALUES('tree.com','manual-check',?)",new Date(TEST_NOW+3600000).toISOString()).run();
  await store.stmt('UPDATE engine_control SET availability_enabled=1').run();let calls=0;
  await runTick(env,{clock:()=>TEST_NOW+480000,fetcher:async()=>{calls++;throw Error('Unexpected registrar call')}});
  assert.equal(calls,0);const job=await store.stmt("SELECT * FROM jobs WHERE kind='availability'").first();assert.equal(job.error_code,'no_eligible_domains');env.DB.close();
});
