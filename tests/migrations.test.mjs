import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {LocalD1,migrateLocal} from '../scripts/sqlite.mjs';
import {LabStore} from '../lib/store.js';
import {TEST_NOW} from './helpers.mjs';

test('all journaled migrations apply to a fresh SQLite database in order',async()=>{
  const db=new LocalD1();migrateLocal(db);
  const control=await new LabStore(db).control();assert.equal(control.paused,1);assert.equal(control.availability_enabled,0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM local_migration_journal').get().n,7);
  assert.equal(db.sqlite.prepare('PRAGMA foreign_key_check').all().length,0);db.close();
});
test('upgrade preserves existing observations, favorites, rejection reasons, reviews and manual leases',()=>{
  const db=new LocalD1();migrateLocal(db,{through:5});
  const stamp=new Date(TEST_NOW).toISOString();
  db.sqlite.prepare("INSERT INTO words(domain,word,meaning,language,source,fetched,native,favorite,triage,reason) VALUES('tree.com','tree','A woody plant','English','https://en.wiktionary.org/wiki/tree',?,'',1,'shortlist','Keep for nature project')").run(stamp);
  db.sqlite.prepare("INSERT INTO observations VALUES('tree.com','registered',?,'https://www.namecheap.com/domains/','Synthetic dated manual evidence')").run(stamp);
  db.sqlite.prepare("INSERT INTO reviews(word,meaning,source,fetched,decision,review_note) VALUES('अम्बक','Raw source','https://ne.wiktionary.org/wiki/test',?,'rejected','Earlier decision')").run(stamp);
  db.sqlite.prepare("INSERT INTO leases VALUES('tree.com','manual-batch',?)").run(new Date(TEST_NOW+600000).toISOString());
  const before=Object.fromEntries(['words','observations','reviews','leases'].map(table=>[table,db.sqlite.prepare('SELECT * FROM '+table).all()]));
  migrateLocal(db);
  for(const table of Object.keys(before))for(const [key,value] of Object.entries(before[table][0]))assert.deepEqual(db.sqlite.prepare('SELECT * FROM '+table).get()[key],value,`${table}.${key}`);
  assert.equal(db.sqlite.prepare('SELECT accepted FROM meanings').get().accepted,0);
  assert.equal(db.sqlite.prepare('SELECT origin FROM meanings').get().origin,'legacy_history');
  assert.equal(db.sqlite.prepare('SELECT status FROM availability_events').get().status,'registered');
  migrateLocal(db);assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM meanings').get().n,1);db.close();
});
test('migration failures roll back atomically rather than leaving half an upgrade',()=>{
  const db=new LocalD1();migrateLocal(db,{through:5});
  const sql=fs.readFileSync('drizzle/0006_autonomous.sql','utf8');
  db.sqlite.exec('BEGIN IMMEDIATE');
  assert.throws(()=>db.sqlite.exec(sql+'\nINSERT INTO no_such_table VALUES(1);'));
  db.sqlite.exec('ROLLBACK');
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='engine_control'").get().n,0);
  migrateLocal(db);assert.equal(db.sqlite.prepare('SELECT paused FROM engine_control').get().paused,1);db.close();
});
