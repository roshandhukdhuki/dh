import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorker} from '../worker.js';
import {testEnv,TEST_NOW,apiRequest,fixtureSources} from './helpers.mjs';

test('external tick is opt-in, private, validated and idempotent across replays',async()=>{
  const env=testEnv(),source=fixtureSources(),app=createWorker({clock:()=>TEST_NOW,fetcher:source.fetcher});
  const payload={request_id:'12345:1',event:'schedule'};
  assert.equal((await app.fetch(apiRequest('engine/tick',payload),env)).status,409);
  env.EXTERNAL_SCHEDULER_ENABLED='true';await app.fetch(apiRequest('engine/control',{paused:false}),env);
  assert.equal((await app.fetch(apiRequest('engine/tick',{...payload,event:'pull_request'}),env)).status,400);
  assert.equal((await app.fetch(apiRequest('engine/tick',payload),{DB:env.DB,EXTERNAL_SCHEDULER_ENABLED:'true'})).status,503);
  const first=await(await app.fetch(apiRequest('engine/tick',payload),env)).json();assert.equal(first.status,'completed');assert.equal(first.completed,2);
  const second=await(await app.fetch(apiRequest('engine/tick',payload),env)).json();assert.equal(second.status,'duplicate_request');assert.equal(source.calls.length,2);
  const persisted=await(await app.fetch(apiRequest('engine/status'),env)).json();assert(persisted.runs.some(r=>r.id===first.run_id&&r.request_id===payload.request_id));
  const state=await(await app.fetch(apiRequest('state'),env)).json();assert.equal(state.scheduler.status,'recent_external_request');assert.equal(state.scheduler.lastScheduledEvent,null);assert.equal(state.scheduler.lastExternalEvent,'github_schedule');env.DB.close();
});
test('a manual GitHub dispatch remains distinct from native cron evidence',async()=>{
  const env=testEnv({EXTERNAL_SCHEDULER_ENABLED:'true'}),app=createWorker({clock:()=>TEST_NOW});
  const result=await(await app.fetch(apiRequest('engine/tick',{request_id:'12345:2',event:'workflow_dispatch'}),env)).json();assert.equal(result.status,'paused_busy_or_not_due');
  const state=await(await app.fetch(apiRequest('state'),env)).json();assert.equal(state.scheduler.lastExternalEvent,'github_dispatch');assert.equal(state.scheduler.lastScheduledEvent,null);assert.equal(state.scheduler.paused,true);env.DB.close();
});
