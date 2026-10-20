import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createCloudflareWorker} from '../cloudflare-worker.js';
import {createCloudflareAccessVerifier} from '../lib/cloudflare-access.js';
import {LabStore} from '../lib/store.js';
import {CADENCE_MS} from '../lib/safety.js';
import {testEnv,TEST_NOW,TEST_PROVIDER,apiRequest,wikiPage,wikiJson} from './helpers.mjs';

// Ephemeral nonextractable signing key used only for local authentication fixtures. No Cloudflare token is created.
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},false,['sign','verify']);
const publicJwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'unit-fixture-key',alg:'RS256',use:'sig'};
const cfConfig={CF_ACCESS_TEAM:'unit-test-team',CF_ACCESS_AUD:'unit-test-audience',CF_ACCESS_OWNER_EMAIL:'owner@example.test',
  CF_ACCESS_OWNER_SUB:'unit-owner',CF_APP_ORIGIN:'https://app.example.test',CLOUDFLARE_PRIVATE_READY:'true'};
const encoded=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
async function ownerAssertion(changes={},headerChanges={}){
  const header=encoded({alg:'RS256',kid:'unit-fixture-key',...headerChanges});
  const payload=encoded({iss:'https://unit-test-team.cloudflareaccess.com',aud:['unit-test-audience'],email:'owner@example.test',
    sub:'unit-owner',iat:TEST_NOW/1000,exp:TEST_NOW/1000+3600,...changes});
  const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(header+'.'+payload));
  return header+'.'+payload+'.'+Buffer.from(signature).toString('base64url');
}
const ownerRequest=async(path,body,changes)=>apiRequest(path,body,{'Cf-Access-Jwt-Assertion':await ownerAssertion(changes)});
const jwks=async()=>new Response(JSON.stringify({keys:[publicJwk]}));

test('all native HTTP surfaces fail closed without real owner Access identity',async()=>{
  const env=testEnv(cfConfig);let network=0;const app=createCloudflareWorker({jwksFetcher:async()=>{network++;throw Error()},clock:()=>TEST_NOW});
  for(const path of ['/','/app.js','/api/state','/api/engine/run','/api/next-batch']){
    const r=new Request('https://app.example.test'+path,{headers:{'Cf-Access-Authenticated-User-Email':'owner@example.test','OAI-Sites-Authorization':'Bearer UNIT_TEST_NOT_ACCESS'}});
    assert.equal((await app.fetch(r,env)).status,403);
  }
  assert.equal(network,0);assert.equal(env.DB.queryCount,0);
  assert.equal((await app.fetch(apiRequest('state'),{...env,CLOUDFLARE_PRIVATE_READY:'false'})).status,503);env.DB.close();
});
test('signed owner assertions are checked for signature, issuer, audience, expiry and owner pin',async()=>{
  const verify=createCloudflareAccessVerifier({fetcher:jwks,clock:()=>TEST_NOW});
  assert((await verify(await ownerRequest('state'),cfConfig)).ok);
  for(const changes of [{iss:'https://evil.test'},{aud:['other-app']},{exp:TEST_NOW/1000},{iat:TEST_NOW/1000+3600},
    {email:'other@example.test'},{sub:'another-owner'},{email:undefined,common_name:'service-identity'}]){
    assert.equal((await verify(await ownerRequest('state',undefined,changes),cfConfig)).ok,false);
  }
  const signed=await ownerAssertion(),parts=signed.split('.');parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1);
  assert.equal((await verify(apiRequest('state',undefined,{'Cf-Access-Jwt-Assertion':parts.join('.')}),cfConfig)).ok,false);
  const none=await ownerAssertion({}, {alg:'none'});assert.equal((await verify(apiRequest('state',undefined,{'Cf-Access-Jwt-Assertion':none}),cfConfig)).ok,false);
});
test('public certificate fetch is fixed to the configured team and public keys are cached',async()=>{
  const urls=[];const verify=createCloudflareAccessVerifier({clock:()=>TEST_NOW,fetcher:async(url,options)=>{
    urls.push(url);assert.equal(options.redirect,'error');return jwks();
  }});
  for(let i=0;i<3;i++)assert((await verify(await ownerRequest('state'),cfConfig)).ok);
  assert.deepEqual(urls,['https://unit-test-team.cloudflareaccess.com/cdn-cgi/access/certs']);
  assert.equal((await verify(await ownerRequest('state'),{...cfConfig,CF_ACCESS_TEAM:'https://127.0.0.1'})).configured,false);
  const wrongOrigin=new Request('https://unprotected.example.test/api/state',{headers:{'Cf-Access-Jwt-Assertion':await ownerAssertion()}});
  assert.equal((await verify(wrongOrigin,cfConfig)).ok,false);
});
test('concurrent certificate retrieval never shares a different Access issuer key set',async()=>{
  let resolveFetch,started;
  const start=new Promise(resolve=>{started=resolve});
  const verify=createCloudflareAccessVerifier({clock:()=>TEST_NOW,fetcher:()=>{started();return new Promise(resolve=>{resolveFetch=resolve})}});
  const firstRequest=await ownerRequest('state');
  const otherRequest=await ownerRequest('state',undefined,{iss:'https://other-team.cloudflareaccess.com'});
  const first=verify(firstRequest,cfConfig);await start;
  assert.equal((await verify(otherRequest,{...cfConfig,CF_ACCESS_TEAM:'other-team'})).ok,false);
  resolveFetch(await jwks());assert((await first).ok);
});
for(const [label,status,header] of [
  ['numeric',429,()=>' 3600 '],
  ['HTTP-date',503,()=>new Date(TEST_NOW+3600000).toUTCString()]
])test(`certificate ${label} Retry-After prevents early requests and recovers when due`,async()=>{
  let now=TEST_NOW,calls=0;
  const verify=createCloudflareAccessVerifier({clock:()=>now,fetcher:async()=>++calls===1?
    new Response('',{status,headers:{'Retry-After':header()}}):jwks()});
  const request=await ownerRequest('state',undefined,{exp:TEST_NOW/1000+86400});
  assert.equal((await verify(request,cfConfig)).ok,false);assert.equal(calls,1);
  now=TEST_NOW+31000;assert.equal((await verify(request,cfConfig)).ok,false);
  now=TEST_NOW+3600000-1;assert.equal((await verify(request,cfConfig)).ok,false);assert.equal(calls,1);
  now++;assert((await verify(request,cfConfig)).ok);assert.equal(calls,2);
});
test('a failed certificate refresh keeps cached keys only until their original expiry',async()=>{
  let now=TEST_NOW,calls=0;
  const verify=createCloudflareAccessVerifier({clock:()=>now,fetcher:async()=>++calls===2?
    new Response('',{status:429,headers:{'Retry-After':'3600'}}):jwks()});
  const claims={exp:TEST_NOW/1000+86400},request=await ownerRequest('state',undefined,claims);
  const unknown=apiRequest('state',undefined,{'Cf-Access-Jwt-Assertion':await ownerAssertion(claims,{kid:'unrecognized-key'})});
  assert((await verify(request,cfConfig)).ok);
  now+=31000;assert.equal((await verify(unknown,cfConfig)).ok,false);assert.equal(calls,2);
  now=TEST_NOW+15*60000-1;assert((await verify(request,cfConfig)).ok);assert.equal(calls,2);
  now++;assert.equal((await verify(request,cfConfig)).ok,false);assert.equal(calls,2);
  now=TEST_NOW+31000+3600000;assert((await verify(request,cfConfig)).ok);assert.equal(calls,3);
});
test('certificate Retry-After deadlines remain scoped to their issuer across other successful fetches',async()=>{
  let now=TEST_NOW;const urls=[];
  const verify=createCloudflareAccessVerifier({clock:()=>now,fetcher:async url=>{
    urls.push(url);return url.startsWith('https://unit-test-team.')?
      new Response('',{status:429,headers:{'Retry-After':'3600'}}):jwks();
  }});
  const first=await ownerRequest('state',undefined,{exp:TEST_NOW/1000+86400});
  assert.equal((await verify(first,cfConfig)).ok,false);now+=31000;
  const other=await ownerRequest('state',undefined,{iss:'https://other-team.cloudflareaccess.com'});
  assert((await verify(other,{...cfConfig,CF_ACCESS_TEAM:'other-team'})).ok);
  assert.equal((await verify(first,cfConfig)).ok,false);
  assert.deepEqual(urls,['https://unit-test-team.cloudflareaccess.com/cdn-cgi/access/certs',
    'https://other-team.cloudflareaccess.com/cdn-cgi/access/certs']);
});
test('certificate transport failures and malformed Retry-After use bounded exponential backoff and recover',async()=>{
  let now=TEST_NOW,calls=0;
  const verify=createCloudflareAccessVerifier({clock:()=>now,fetcher:async()=>{
    calls++;if(calls===7)return jwks();
    if(calls%2===0)return new Response('',{status:503,headers:{'Retry-After':'invalid'}});
    throw Error('synthetic transport failure');
  }});
  const request=await ownerRequest('state',undefined,{exp:TEST_NOW/1000+86400});
  for(const [i,delay] of [30000,60000,120000,240000,300000,300000].entries()){
    assert.equal((await verify(request,cfConfig)).ok,false);assert.equal(calls,i+1);
    now+=delay-1;assert.equal((await verify(request,cfConfig)).ok,false);assert.equal(calls,i+1);now++;
  }
  assert((await verify(request,cfConfig)).ok);assert.equal(calls,7);
});
test('authenticated routes still enforce origin checks and disable external scheduler and registrar activation',async()=>{
  const env=testEnv({...cfConfig,...TEST_PROVIDER}),app=createCloudflareWorker({jwksFetcher:jwks,clock:()=>TEST_NOW});
  const state=await(await app.fetch(await ownerRequest('state'),env)).json();
  assert.equal(state.executionProfile.maxJobs,1);assert.equal(state.provider.ready,false);assert(state.provider.blockers.some(x=>x.includes('disabled')));
  assert.equal((await app.fetch(await ownerRequest('provider',{enabled:true}),env)).status,409);
  assert.equal((await app.fetch(await ownerRequest('engine/tick',{request_id:'123:1',event:'schedule'}),env)).status,404);
  const foreign=apiRequest('engine/control',{paused:false},{Origin:'https://evil.test','Cf-Access-Jwt-Assertion':await ownerAssertion()});
  assert.equal((await app.fetch(foreign,env)).status,403);env.DB.close();
});
test('native cron performs one bounded dictionary job, weights Nepali first, and never calls a registrar',async()=>{
  const base=TEST_NOW-(Math.floor(TEST_NOW/CADENCE_MS)%3)*CADENCE_MS;
  const env=testEnv({...cfConfig,...TEST_PROVIDER}),store=new LabStore(env.DB);await store.setPaused(false,base);
  await store.stmt('UPDATE engine_control SET availability_enabled=1').run();
  let now=base;const calls=[];
  const app=createCloudflareWorker({clock:()=>now,jwksFetcher:async()=>{throw Error('Cron must not fetch identity keys')},sourceFetcher:async(url)=>{
    const u=new URL(url);assert.equal(u.searchParams.get('gaplimit'),'1');calls.push(u.hostname);
    assert(u.hostname.endsWith('.wiktionary.org'));return wikiJson([wikiPage(u.hostname.startsWith('ne.')?'अर्ना':'tree',
      u.hostname.startsWith('ne.')?'==नेपाली==\n===अर्थ===\n# जङ्गली भाले भैँसी':'==English==\n# A woody plant.',calls.length)],'next-'+calls.length);
  }});
  for(let i=0;i<3;i++){
    now=base+i*CADENCE_MS;env.DB.queryCount=0;
    const result=await app.scheduled({scheduledTime:now},env);assert.equal(result.completed,1);assert(env.DB.queryCount<=30);
  }
  assert.deepEqual(calls,['ne.wiktionary.org','ne.wiktionary.org','en.wiktionary.org']);
  assert.equal((await store.stmt('SELECT SUM(ticks) AS n FROM native_daily_budget').first()).n,3);env.DB.close();
});
test('daily cap is persistent and prevents further native requests',async()=>{
  const env=testEnv(cfConfig),store=new LabStore(env.DB);await store.setPaused(false,TEST_NOW);
  await store.stmt('INSERT INTO native_daily_budget VALUES(?,360)',new Date(TEST_NOW).toISOString().slice(0,10)).run();
  let requests=0;const app=createCloudflareWorker({clock:()=>TEST_NOW,sourceFetcher:async()=>{requests++;throw Error()}});
  assert.equal((await app.scheduled({scheduledTime:TEST_NOW},env)).status,'daily_budget_reached');assert.equal(requests,0);
  assert.equal((await store.stmt('SELECT ticks FROM native_daily_budget').first()).ticks,360);
  assert.equal((await store.stmt('SELECT status FROM engine_runs').first()).status,'daily_budget_reached');env.DB.close();
});
test('light native status exposes the persistent UTC cap without corpus counting',async()=>{
  const env=testEnv(cfConfig),store=new LabStore(env.DB);
  await store.reserveDailyTick(TEST_NOW,360);env.DB.queryCount=0;
  const app=createCloudflareWorker({clock:()=>TEST_NOW,jwksFetcher:jwks});
  const state=await(await app.fetch(await ownerRequest('engine/status'),env)).json();
  assert.deepEqual(state.usage,{day:new Date(TEST_NOW).toISOString().slice(0,10),ticks:1});
  assert.equal(env.DB.queryCount,5);assert.equal(state.executionProfile.dailyTickCap,360);
  assert(env.DB.sqlite.prepare('EXPLAIN QUERY PLAN SELECT * FROM engine_runs ORDER BY started_at DESC LIMIT 5').all()
    .some(row=>row.detail.includes('engine_runs_started')));env.DB.close();
});
test('oversized source responses fail visibly without promoting a meaning',async()=>{
  const env=testEnv(cfConfig),store=new LabStore(env.DB);await store.setPaused(false,TEST_NOW);
  const app=createCloudflareWorker({clock:()=>TEST_NOW,sourceFetcher:async()=>new Response('x'.repeat(32769))});
  const result=await app.scheduled({scheduledTime:TEST_NOW},env);assert.equal(result.status,'partial');
  assert.equal((await store.stmt("SELECT error_code FROM jobs WHERE status='failed'").first()).error_code,'response_too_large');
  assert.equal((await store.stmt('SELECT COUNT(*) AS n FROM words').first()).n,0);env.DB.close();
});
test('native configuration is inactive and builds an independently protected Worker',async()=>{
  const config=JSON.parse(fs.readFileSync('deploy/cloudflare/wrangler.example.jsonc','utf8').replace(/^\s*\/\/.*$/gm,''));
  assert.deepEqual(config.triggers.crons,['*/4 * * * *']);assert.equal(config.workers_dev,false);assert.equal(config.preview_urls,false);
  assert.equal(config.vars.SCHEDULER_ENABLED,'false');assert.equal(config.vars.CLOUDFLARE_PRIVATE_READY,'false');assert.deepEqual(config.routes,[]);
  assert(config.d1_databases[0].database_id.startsWith('REPLACE_'));
  execFileSync(process.execPath,['build.mjs','--cloudflare'],{stdio:'pipe'});
  const native=await import('../dist/cloudflare/index.js?native-test');
  const response=await native.default.fetch(apiRequest('state'),testEnv(cfConfig));assert.equal(response.status,403);
});
