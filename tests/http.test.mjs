import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorker} from '../worker.js';
import {LabStore} from '../lib/store.js';
import {testEnv,TEST_NOW,TEST_PROVIDER,apiRequest,fixtureSources,wikiPage,word} from './helpers.mjs';
import {runTick} from '../lib/engine.js';

test('unconfirmed deployments fail closed, including HTML and browser scripts',async()=>{
  const app=createWorker();for(const path of ['/','/app.js','/api/state'])assert.equal((await app.fetch(new Request('https://app.example.test'+path),{})).status,503);
});
test('read-only state does not seed historical research or perform an external lookup',async()=>{
  const env=testEnv(),app=createWorker({clock:()=>TEST_NOW,fetcher:async()=>{throw Error('No network expected')}});
  const state=await(await app.fetch(apiRequest('state'),env)).json();assert.equal(state.totals.words,0);assert.equal(state.provider.status,'not_configured');assert.equal(state.scheduler.status,'paused');env.DB.close();
});
test('HTTP queue → execution → SQLite → filtered response works end to end',async()=>{
  const env=testEnv();const source=fixtureSources(),app=createWorker({clock:()=>TEST_NOW,fetcher:source.fetcher});
  assert.equal((await app.fetch(apiRequest('engine/control',{paused:false}),env)).status,200);
  assert.equal((await app.fetch(apiRequest('refresh',{source:'nepali'}),env)).status,202);
  const run=await(await app.fetch(apiRequest('engine/run',{}),env)).json();assert.equal(run.completed,2);
  const names=await(await app.fetch(apiRequest('candidates?language=Nepali&group=4&evidence=verified&sort=name'),env)).json();
  assert.equal(names.total,1);assert.equal(names.words[0].domain,'arna.com');assert.equal(names.words[0].observation,null);assert.equal(names.words[0].evidence_status,'dictionary_definition_verified');
  await app.fetch(apiRequest('triage',{domain:'arna.com',triage:'shortlist',reason:'A memorable practical spelling'}),env);
  const saved=await(await app.fetch(apiRequest('candidates?saved=1'),env)).json();assert.equal(saved.total,1);
  const state=await(await app.fetch(apiRequest('state'),env)).json();assert.equal(state.scheduler.status,'schedule_not_verified');assert.equal(state.totals.saved,1);env.DB.close();
});
test('explicit assistant review is never stored or reported as owner review',async()=>{
  const env=testEnv();const app=createWorker({clock:()=>TEST_NOW,fetcher:fixtureSources({nepali:[wikiPage('अम्बक','==नेपाली==\n===अर्थ===\n# अम्बा वा बेलौती',1)]}).fetcher});
  await app.fetch(apiRequest('engine/control',{paused:false}),env);await app.fetch(apiRequest('engine/run',{}),env);
  const body={word:'अम्बक',action:'approve',reviewer:'assistant',romanization:'ambak',meaning:'Guava (reviewer translation)',method:'Source-backed practical spelling review; final schwa omitted',confidence:0.95,note:'Reviewed the explicit Nepali अर्थ section and practical ambak spelling.',confirmed:true};
  assert.equal((await app.fetch(apiRequest('review',{...body,reviewer:undefined}),env)).status,400);
  const response=await app.fetch(apiRequest('review',body),env);assert.equal(response.status,200);
  const row=await new LabStore(env.DB).stmt("SELECT * FROM meanings WHERE domain='ambak.com'").first();assert.equal(row.review_actor,'assistant');assert.equal(row.romanization_status,'assistant_reviewed_practical');
  assert.equal(row.definition,'अम्बा वा बेलौती');assert.equal(row.reviewed_definition,body.meaning);
  const state=await(await app.fetch(apiRequest('state'),env)).json();assert.equal(state.reviews[0].reviewer_type,'assistant');assert.equal(state.reviews[0].decision,'assistant_reviewed');env.DB.close();
});
test('rejecting a rule-reviewed entry removes it from automatic eligibility while retaining evidence',async()=>{
  const env=testEnv();const app=createWorker({clock:()=>TEST_NOW,fetcher:fixtureSources().fetcher});
  await app.fetch(apiRequest('engine/control',{paused:false}),env);await app.fetch(apiRequest('engine/run',{}),env);
  await app.fetch(apiRequest('review',{word:'अर्ना',action:'reject',reviewer:'assistant',note:'Keep source evidence; spelling needs further review.'}),env);
  const store=new LabStore(env.DB);assert.equal((await store.stmt("SELECT accepted FROM meanings WHERE domain='arna.com'").first()).accepted,0);
  assert.deepEqual(await store.eligibleDomains(['arna.com'],TEST_NOW),[]);assert.equal((await store.stmt('SELECT COUNT(*) AS n FROM dictionary_entries').first()).n,2);env.DB.close();
});
test('source refresh preserves rejected and explicitly reviewed decisions',async()=>{
  const env=testEnv();const store=new LabStore(env.DB);await store.setPaused(false,TEST_NOW);
  await runTick(env,{clock:()=>TEST_NOW,fetcher:fixtureSources({next:'next-page'}).fetcher});
  await store.stmt("UPDATE reviews SET decision='rejected',review_note='Earlier judgment' WHERE word='अर्ना'").run();
  await store.stmt("UPDATE meanings SET accepted=0 WHERE native='अर्ना'").run();
  await runTick(env,{clock:()=>TEST_NOW+240000,fetcher:fixtureSources().fetcher});
  assert.equal((await store.stmt("SELECT decision FROM reviews WHERE word='अर्ना'").first()).decision,'rejected');assert.equal((await store.stmt("SELECT accepted FROM meanings WHERE native='अर्ना'").first()).accepted,0);env.DB.close();
});
test('import is atomic, idempotent, dated and cannot replace a newer observation with old data',async()=>{
  const env=testEnv();const store=new LabStore(env.DB);await word(store);const app=createWorker({clock:()=>TEST_NOW});
  const row={domain:'tree.com',status:'standard_offer',checked_at:new Date(TEST_NOW).toISOString(),source_url:'https://www.namecheap.com/domains/',evidence:'Synthetic manual observation: displayed offer',price:12.3,currency:'USD',period_months:12};
  const unknown={...row,domain:'wood.com'};
  assert.equal((await app.fetch(apiRequest('observations',{observations:[row,unknown]}),env)).status,400);
  assert.equal((await store.stmt('SELECT COUNT(*) AS n FROM availability_events').first()).n,0);
  for(let i=0;i<2;i++)assert.equal((await app.fetch(apiRequest('observations',{observations:[row]}),env)).status,200);
  assert.equal((await store.stmt('SELECT COUNT(*) AS n FROM availability_events').first()).n,1);
  await app.fetch(apiRequest('observations',{observations:[{...row,status:'registered',checked_at:new Date(TEST_NOW-3600000).toISOString()}]}),env);
  assert.equal((await store.stmt('SELECT status FROM observations').first()).status,'standard_offer');
  const response=await(await app.fetch(apiRequest('candidates'),env)).json();assert.equal(response.words[0].observation.price,12.3);env.DB.close();
});
test('provider configuration interface accepts switches only and never exposes secrets',async()=>{
  const env=testEnv(TEST_PROVIDER),app=createWorker({clock:()=>TEST_NOW});
  const response=await app.fetch(apiRequest('state'),env);const text=await response.text();assert(!text.includes(TEST_PROVIDER.NAMECHEAP_API_KEY));assert(!text.includes(TEST_PROVIDER.NAMECHEAP_API_USER));assert(!text.includes(TEST_PROVIDER.NAMECHEAP_CLIENT_IPV4));
  assert.equal((await app.fetch(apiRequest('provider',{enabled:true,ApiKey:'no-secrets-through-ui'}),env)).status,400);
  assert.equal((await app.fetch(apiRequest('provider',{enabled:true}),testEnv())).status,409);env.DB.close();
});
test('cross-origin changes, invalid JSON, oversized imports and SQL-shaped filters are rejected safely',async()=>{
  const env=testEnv(),app=createWorker({clock:()=>TEST_NOW});
  assert.equal((await app.fetch(apiRequest('engine/control',{paused:false},{Origin:'https://evil.test'}),env)).status,403);
  assert.equal((await app.fetch(new Request('https://app.example.test/api/triage',{method:'POST',headers:{'Content-Type':'application/json'},body:'{broken'}),env)).status,400);
  assert.equal((await app.fetch(new Request('https://app.example.test/api/observations',{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(100001)}),env)).status,413);
  assert.equal((await app.fetch(apiRequest('candidates?sort=DROP%20TABLE%20words'),env)).status,400);
  assert.equal((await app.fetch(apiRequest('candidates?q='+encodeURIComponent('नेपाली'.repeat(10))),env)).status,400);
  assert.equal((await app.fetch(apiRequest('candidates?q=%25%27%20OR%201%3D1'),env)).status,200);env.DB.close();
});
test('scheduled handler records actual delivery and uses waitUntil without claiming deployment',async()=>{
  const env=testEnv(),app=createWorker({clock:()=>TEST_NOW});let pending;
  await app.scheduled({scheduledTime:TEST_NOW},env,{waitUntil:work=>pending=work});await pending;
  const state=await(await app.fetch(apiRequest('state'),env)).json();assert.equal(state.scheduler.lastScheduledEvent,new Date(TEST_NOW).toISOString());assert.equal(state.scheduler.paused,true);assert.equal(state.control.last_run_at,null);env.DB.close();
});
