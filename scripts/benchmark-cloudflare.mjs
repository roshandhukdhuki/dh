// Local CPU proxy only: no network, cloud resource, credential, deployment or live database access.
import {LocalD1,migrateLocal} from './sqlite.mjs';
import {LabStore} from '../lib/store.js';
import {createCloudflareWorker} from '../cloudflare-worker.js';
import {CADENCE_MS} from '../lib/safety.js';

const micros=()=>{const c=process.cpuUsage();return c.user+c.system};
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*p)-1)];
function instrument(raw){
  let dbCpu=0;
  async function timed(fn){const before=micros();try{return await fn()}finally{dbCpu+=micros()-before}}
  const wrap=stmt=>({raw:stmt,bind(...args){return wrap(stmt.bind(...args))},first:()=>timed(()=>stmt.first()),
    all:()=>timed(()=>stmt.all()),run:()=>timed(()=>stmt.run())});
  return {prepare:sql=>wrap(raw.prepare(sql)),batch:items=>timed(()=>raw.batch(items.map(s=>s.raw))),
    reset(){dbCpu=0;raw.queryCount=0},get dbCpu(){return dbCpu}};
}
const report={kind:'local_node_sqlite_cpu_proxy',node:process.version,platform:process.platform,architecture:process.arch,
  warning:'Not Cloudflare CPU metering. SQL execution is subtracted as a local proxy; asynchronous runtime/crypto accounting, cold startup, hardware and D1 differ. Hosted canary CPU must pass before cutover.',scenarios:[]};
for(const scenario of ['near-cap-nepali-success','rate-limited']){
  const raw=new LocalD1();migrateLocal(raw);const DB=instrument(raw),store=new LabStore(DB);
  let now=Date.parse('2026-10-20T12:00:00Z');now-=Math.floor(now/CADENCE_MS)%3*CADENCE_MS;
  await store.setPaused(false,now);let sequence=0,networkCalls=0;
  const rawText='==नेपाली==\n===अर्थ===\n# जङ्गली भाले भैँसी\n'+'क'.repeat(7800);
  const body=JSON.stringify({batchcomplete:true,continue:{gapcontinue:'next-page'},query:{pages:[{pageid:1,ns:0,title:'अर्ना',
    revisions:[{revid:1001,timestamp:'2026-10-19T00:00:00Z',slots:{main:{content:rawText}}}]}]}});
  const env={DB,CF_ACCESS_TEAM:'fixture-team',CF_ACCESS_AUD:'fixture-aud',CF_ACCESS_OWNER_EMAIL:'owner@example.test',
    CF_APP_ORIGIN:'https://app.example.test',CLOUDFLARE_PRIVATE_READY:'true',SCHEDULER_ENABLED:'true'};
  const app=createCloudflareWorker({clock:()=>now,sourceFetcher:async()=>{networkCalls++;return scenario==='rate-limited'?
    new Response('',{status:429,headers:{'Retry-After':'600'}}):new Response(body)}});
  const samples=[];
  for(let i=0;i<121;i++){
    sequence++;now+=3*CADENCE_MS;
    await store.stmt("UPDATE source_health SET cursor=?,status='ready',exhausted=0,next_allowed_at=0 WHERE source='nepali'",'bench-'+sequence).run();
    DB.reset();const callsBefore=networkCalls,startCpu=micros(),startWall=performance.now();
    const result=await app.scheduled({scheduledTime:now},env);
    const total=micros()-startCpu;
    samples.push({totalCpuMs:total/1000,sqliteCpuMs:DB.dbCpu/1000,proxyComputeCpuMs:Math.max(0,total-DB.dbCpu)/1000,
      wallMs:performance.now()-startWall,sqlStatements:raw.queryCount,requests:networkCalls-callsBefore,status:result.status});
  }
  const warm=samples.slice(1),metric=name=>({p50:percentile(warm.map(s=>s[name]),0.5),p95:percentile(warm.map(s=>s[name]),0.95),max:Math.max(...warm.map(s=>s[name]))});
  report.scenarios.push({scenario,payloadBytes:scenario==='rate-limited'?0:new TextEncoder().encode(body).length,warmSamples:warm.length,
    firstCall:samples[0],proxyComputeCpuMs:metric('proxyComputeCpuMs'),totalLocalCpuMs:metric('totalCpuMs'),
    maxSqlStatements:Math.max(...samples.map(s=>s.sqlStatements)),maxRequests:Math.max(...samples.map(s=>s.requests))});
  raw.close();
}
console.log(JSON.stringify(report,null,2));
