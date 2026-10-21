import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {testEnv,TEST_NOW,apiRequest,fixtureSources} from './helpers.mjs';

test('production bundle serves private HTML/scripts and the complete compiled pipeline',async()=>{
  execFileSync(process.execPath,['build.mjs'],{stdio:'pipe'});
  const bundle=await import('../dist/server/index.js?verification');const env=testEnv();
  const html=await(await bundle.default.fetch(new Request('https://app.example.test/'),env)).text();
  assert(html.includes('Reserve next batch'));assert(html.includes('Resume selected batch'));assert(html.includes('Release selected batch'));
  const script=await(await bundle.default.fetch(new Request('https://app.example.test/app.js'),env)).text();assert(script.includes('artha.pendingBatch'));
  assert.equal((await bundle.default.fetch(new Request('https://app.example.test/'),{})).status,503);
  const app=bundle.createWorker({clock:()=>TEST_NOW,fetcher:fixtureSources().fetcher});
  await app.fetch(apiRequest('engine/control',{paused:false}),env);
  const run=await(await app.fetch(apiRequest('engine/run',{}),env)).json();assert.equal(run.completed,2);
  const names=await(await app.fetch(apiRequest('candidates'),env)).json();assert.equal(names.total,2);env.DB.close();
});
test('public documentation and tracked source omit private Site URLs and hosting identities',()=>{
  for(const file of ['README.md','DEPLOYMENT.md','index.html','worker.js','.env.example']) {
    const text=fs.readFileSync(file,'utf8');assert(!/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.chatgpt\.site/i.test(text));
    assert(!/appgprj_[a-z0-9]+/.test(text));assert(!text.includes('/Users/'));
  }
});
