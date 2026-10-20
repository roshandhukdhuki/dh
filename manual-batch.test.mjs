import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import worker from './worker.js';
import {validManualRequest,listManualBatches,reserveManualBatch,releaseManualBatch} from './manual-batches.js';

const NOW=Date.parse('2026-10-20T12:00:00Z');
function database(){
  const sqlite=new DatabaseSync(':memory:');
  for(const name of fs.readdirSync('drizzle').filter(x=>x.endsWith('.sql')).sort())sqlite.exec(fs.readFileSync('drizzle/'+name,'utf8'));
  function prepare(sql){function bound(args=[]){return {bind(...values){return bound(values)},async first(){return sqlite.prepare(sql).get(...args)||null},async all(){return {results:sqlite.prepare(sql).all(...args)}},async run(){return sqlite.prepare(sql).run(...args)},execute(){const statement=sqlite.prepare(sql);return statement.columns().length?statement.all(...args):statement.run(...args)}}}return bound()}
  return {sqlite,prepare,async batch(items){sqlite.exec('BEGIN IMMEDIATE');try{const results=items.map(x=>x.execute());sqlite.exec('COMMIT');return results}catch(error){sqlite.exec('ROLLBACK');throw error}}};
}
function add(db,domain,language='English'){db.sqlite.prepare('INSERT INTO words(domain,word,meaning,language,source,fetched) VALUES(?,?,?,?,?,?)').run(domain,domain.slice(0,-4),'Synthetic dictionary meaning',language,'https://en.wiktionary.org/wiki/test',new Date(NOW).toISOString())}
const body=(count=2,request_id=crypto.randomUUID())=>({count,request_id});

test('manual batch validates 1–20 integer count and a stable UUID request ID',()=>{
  assert(validManualRequest(body()));for(const count of [0,21,1.2,'2'])assert(!validManualRequest(body(count)));
  assert(!validManualRequest({count:2}));assert(!validManualRequest(body(2,'bad')));
});
test('five concurrent replays return one reservation and exactly the original leased names',async()=>{
  const db=database();for(const name of ['tree.com','wood.com','home.com','lake.com'])add(db,name);
  const request=body();const results=await Promise.all(Array.from({length:5},()=>reserveManualBatch(db,request,NOW)));
  assert.equal(new Set(results.map(r=>r.batch_id)).size,1);assert(results.every(r=>r.words.length===2));
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM leases').get().n,2);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM history WHERE action='Batch reserved'").get().n,1);db.sqlite.close();
});
test('separate batches do not overlap and Nepali retains priority',async()=>{
  const db=database();add(db,'tree.com');add(db,'arna.com','Nepali');add(db,'wood.com');
  const first=await reserveManualBatch(db,body(1),NOW),second=await reserveManualBatch(db,body(2),NOW);
  assert.equal(first.words[0].domain,'arna.com');assert.equal(second.words.length,2);assert(second.words.every(w=>w.domain!=='arna.com'));db.sqlite.close();
});
test('resuming is read-only; release is idempotent and preserves another active batch',async()=>{
  const db=database();for(const name of ['tree.com','wood.com','home.com','lake.com'])add(db,name);
  const first=await reserveManualBatch(db,body(),NOW),second=await reserveManualBatch(db,body(),NOW);
  const before=db.sqlite.prepare('SELECT COUNT(*) AS n FROM history').get().n;
  for(let i=0;i<3;i++)assert.equal((await listManualBatches(db,NOW)).find(b=>b.id===first.batch_id).words.length,2);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM history').get().n,before);
  for(let i=0;i<2;i++)assert(await releaseManualBatch(db,first.batch_id,NOW));
  assert.equal((await listManualBatches(db,NOW)).find(b=>b.id===first.batch_id).state,'released');
  assert(db.sqlite.prepare('SELECT * FROM leases').all().every(l=>l.batch_id===second.batch_id));
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM history WHERE action='Batch released'").get().n,1);db.sqlite.close();
});
test('empty or expired replay cannot claim new names or release a newer lease',async()=>{
  const db=database(),emptyRequest=body(1);await reserveManualBatch(db,emptyRequest,NOW);add(db,'tree.com');
  assert.equal((await reserveManualBatch(db,emptyRequest,NOW+1)).words.length,0);
  const first=await reserveManualBatch(db,body(1),NOW),second=await reserveManualBatch(db,body(1),NOW+13*60000);
  assert.equal((await reserveManualBatch(db,{count:1,request_id:first.batch_id},NOW+13*60000)).words.length,0);
  await releaseManualBatch(db,first.batch_id,NOW+14*60000);
  assert.equal(db.sqlite.prepare('SELECT batch_id FROM leases').get().batch_id,second.batch_id);db.sqlite.close();
});
test('existing manual leases resume and release without any schema migration',async()=>{
  const db=database();add(db,'tree.com');const id=crypto.randomUUID();
  db.sqlite.prepare('INSERT INTO leases VALUES(?,?,?)').run('tree.com',id,new Date(NOW+600000).toISOString());
  assert.equal((await listManualBatches(db,NOW))[0].words[0].domain,'tree.com');assert(await releaseManualBatch(db,id,NOW));
  assert.equal((await listManualBatches(db,NOW))[0].state,'released');db.sqlite.close();
});
test('cross-origin reservation and release are rejected before changing storage',async()=>{
  const db=database();add(db,'tree.com');
  for(const path of ['next-batch','batches/release']){
    const request=new Request('https://private.example.test/api/'+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.test'},body:JSON.stringify(body())});
    assert.equal((await worker.fetch(request,{DB:db})).status,403);
  }
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM leases').get().n,0);db.sqlite.close();
});
test('HTTP visible-workflow routes reserve, read back and release the same batch',async()=>{
  const db=database();add(db,'tree.com');const request=body(1);
  const call=(path,data)=>worker.fetch(new Request('https://private.example.test/api/'+path,data?{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://private.example.test'},body:JSON.stringify(data)}:{}),{DB:db});
  const reserved=await(await call('next-batch',request)).json();assert.equal(reserved.words.length,1);
  const read=await(await call('batches')).json();assert.equal(read.batches[0].id,reserved.batch_id);
  assert.equal((await call('batches/release',{batch_id:reserved.batch_id})).status,200);db.sqlite.close();
});
test('build embeds visible controls and a self-contained Worker without private URLs',async()=>{
  execFileSync(process.execPath,['build.mjs'],{stdio:'pipe'});
  const html=fs.readFileSync('index.html','utf8');for(const label of ['Reserve next batch','Resume selected batch','Release selected batch'])assert(html.includes(label));
  execFileSync(process.execPath,['--check','--input-type=module'],{input:html.split('<script>')[1].split('</script>')[0],stdio:['pipe','pipe','pipe']});
  const bundle=await import('./dist/server/index.js?manual-batch-test');assert.equal(typeof bundle.default.fetch,'function');
  assert(!/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.chatgpt\.site/.test(fs.readFileSync('README.md','utf8')));
});
