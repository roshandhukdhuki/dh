// Local development/test adapter only. Production receives a Cloudflare D1 binding.
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export class LocalD1 {
  constructor(filename = ':memory:') {
    this.queryCount=0;
    this.sqlite = new DatabaseSync(filename);
    this.sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  }
  prepare(sql) {
    const db = this.sqlite;
    const owner=this;
    function statement(args = []) {
      return {bind(...values) { return statement(values); },
        async first(column) { owner.queryCount++;const row = db.prepare(sql).get(...args); return column ? row?.[column] ?? null : row ?? null; },
        async all() { owner.queryCount++;return {success:true,results:db.prepare(sql).all(...args)}; },
        async run() { owner.queryCount++;const result=db.prepare(sql).run(...args);return {success:true,meta:{changes:Number(result.changes)}}; },
        execute() { owner.queryCount++;const stmt=db.prepare(sql);if(stmt.columns().length)return {success:true,results:stmt.all(...args)};
          const result=stmt.run(...args);return {success:true,results:[],meta:{changes:Number(result.changes)}}; }
      };
    }
    return statement();
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try { const results=statements.map(s=>s.execute());this.sqlite.exec('COMMIT');return results; }
    catch(error) { this.sqlite.exec('ROLLBACK');throw error; }
  }
  close() { this.sqlite.close(); }
}

export function migrateLocal(db, {through = 6, root = process.cwd()} = {}) {
  db.sqlite.exec('CREATE TABLE IF NOT EXISTS local_migration_journal(tag TEXT PRIMARY KEY)');
  const journal=JSON.parse(fs.readFileSync(path.join(root,'drizzle/meta/_journal.json'),'utf8'));
  for(const entry of journal.entries.filter(e=>e.idx<=through)) {
    if(db.sqlite.prepare('SELECT tag FROM local_migration_journal WHERE tag=?').get(entry.tag))continue;
    db.sqlite.exec('BEGIN IMMEDIATE');
    try {
      db.sqlite.exec(fs.readFileSync(path.join(root,'drizzle',entry.tag+'.sql'),'utf8'));
      db.sqlite.prepare('INSERT INTO local_migration_journal VALUES(?)').run(entry.tag);
      db.sqlite.exec('COMMIT');
    } catch(error) { db.sqlite.exec('ROLLBACK');throw error; }
  }
}
