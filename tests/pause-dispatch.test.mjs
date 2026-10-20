import test from 'node:test';
import assert from 'node:assert/strict';
import {LabStore} from '../lib/store.js';
import {runTick} from '../lib/engine.js';
import {readyEnv,TEST_NOW,TEST_PROVIDER,fixtureSources} from './helpers.mjs';

test('a completed pause after claim prevents the dictionary request and reports paused',async()=>{
  const env=await readyEnv();const original=LabStore.prototype.claim;let calls=0;
  LabStore.prototype.claim=async function(...args){const job=await original.apply(this,args);if(job)await this.setPaused(true,TEST_NOW);return job};
  try{
    const result=await runTick(env,{clock:()=>TEST_NOW,fetcher:async()=>{calls++;throw Error('Must not dispatch')}});
    assert.equal(result.status,'paused');assert.equal(calls,0);
    assert.equal((await new LabStore(env.DB).stmt('SELECT COUNT(*) AS n FROM words').first()).n,0);
  }finally{LabStore.prototype.claim=original;env.DB.close()}
});
test('a pause completed during provider eligibility lookup prevents registrar dispatch',async()=>{
  const env=await readyEnv(TEST_PROVIDER),store=new LabStore(env.DB);await runTick(env,{clock:()=>TEST_NOW,fetcher:fixtureSources().fetcher});
  await store.stmt('UPDATE engine_control SET availability_enabled=1').run();
  const original=LabStore.prototype.eligibleDomains;let calls=0;
  LabStore.prototype.eligibleDomains=async function(...args){const result=await original.apply(this,args);await this.setPaused(true,TEST_NOW+240000);return result};
  try{
    const result=await runTick(env,{clock:()=>TEST_NOW+240000,fetcher:async()=>{calls++;throw Error('Must not dispatch')}});
    assert.equal(result.status,'paused');assert.equal(calls,0);
  }finally{LabStore.prototype.eligibleDomains=original;env.DB.close()}
});
test('cancellation after claim stops the upstream call and reports cancelled',async()=>{
  const env=await readyEnv(),original=LabStore.prototype.claim;let calls=0;
  LabStore.prototype.claim=async function(...args){const job=await original.apply(this,args);if(job)await this.cancelJob(job.id,TEST_NOW);return job};
  try{
    const result=await runTick(env,{clock:()=>TEST_NOW,fetcher:async()=>{calls++;throw Error('Must not dispatch')}});
    assert.equal(result.status,'cancelled');assert.equal(calls,0);
    assert.equal((await new LabStore(env.DB).stmt('SELECT status FROM engine_runs').first()).status,'cancelled');
  }finally{LabStore.prototype.claim=original;env.DB.close()}
});
