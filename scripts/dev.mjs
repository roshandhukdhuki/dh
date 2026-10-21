import http from 'node:http';
import fs from 'node:fs';
import {createWorker} from '../worker.js';
import {PipelineError} from '../lib/safety.js';
import {LocalD1,migrateLocal} from './sqlite.mjs';

const fixtureMode=process.argv.includes('--fixtures');
const port=Number(process.env.ARTHA_DEV_PORT||8877);
const db=fixtureMode?new LocalD1():new LocalD1('artha.local.sqlite');
migrateLocal(db);
let fetcher=async()=>{throw new PipelineError('local_external_access_disabled',{retryable:false})};
if(fixtureMode){const {fixtureSources}=await import('../tests/helpers.mjs');fetcher=fixtureSources().fetcher;}
const banner=fixtureMode?'<div class="notice"><b>LOCAL FIXTURE PREVIEW.</b> Synthetic test responses only. No live dictionary or registrar requests. Nothing is deployed.</div>':'';
const app=createWorker({html:fs.readFileSync('index.html','utf8').replace('<main>','<main>'+banner),client:fs.readFileSync('client.js','utf8'),fetcher});
const env={DB:db,LOCAL_DEV:'true',SCHEDULER_ENABLED:fixtureMode?'true':'false'};
const server=http.createServer(async(req,res)=>{
  try {
    let size=0;const chunks=[];
    for await(const chunk of req){size+=chunk.length;if(size>100000){res.writeHead(413);res.end('Request too large');return;}chunks.push(chunk);}
    const request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers:req.headers,
      ...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
    const response=await app.fetch(request,env);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500);res.end('Local request failed');}
});
server.listen(port,'127.0.0.1',()=>console.log(`Local ${fixtureMode?'fixture preview (no external traffic)':'development (external access disabled)'}: http://127.0.0.1:${port}`));
function stop(){server.close(()=>{db.close();process.exit(0)})}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
