import {CADENCE_MS, LEASE_MS, STALE_MS, retryDelay, stableId, PipelineError} from './safety.js';
import {proposeRomanization} from './romanization.js';
import {brandSignals} from './quality.js';

export class LabStore {
  constructor(db) { this.db = db; }
  stmt(sql, ...args) { return this.db.prepare(sql).bind(...args); }
  async all(sql, ...args) { return (await this.stmt(sql, ...args).all()).results; }
  control() { return this.stmt('SELECT * FROM engine_control WHERE id=1').first(); }
  sources() { return this.all('SELECT * FROM source_health ORDER BY source'); }
  async audit(action, code = '', detail = '', jobId = null, now = Date.now()) {
    await this.stmt('INSERT INTO job_events(job_id,happened,action,code,detail) VALUES(?,?,?,?,?)',
      jobId, new Date(now).toISOString(), action, code, detail).run();
  }
  controlGuard(lease, now) {
    return {sql: 'EXISTS(SELECT 1 FROM engine_control WHERE id=1 AND paused=0 AND lease_token=? AND lease_until>? AND epoch=?)',
      args: [lease.token, now, lease.epoch]};
  }
  jobGuard(job, lease, now) {
    const c = this.controlGuard(lease, now);
    return {sql: `${c.sql} AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND status='running' AND cancel_requested=0 AND lease_token=?)`,
      args: [...c.args, job.id, lease.token]};
  }
  async scheduledSeen(now) {
    await this.stmt('UPDATE engine_control SET last_scheduled_at=? WHERE id=1', new Date(now).toISOString()).run();
  }
  async externalSeen(requestId,event,now) {
    const inserted=await this.stmt(`INSERT OR IGNORE INTO external_invocations(request_id,received_at,event)
      VALUES(?,?,?) RETURNING request_id`,requestId,new Date(now).toISOString(),event).first();
    if(!inserted)return false;
    await this.stmt('UPDATE engine_control SET last_external_tick_at=?,last_external_event=? WHERE id=1',new Date(now).toISOString(),event).run();
    return true;
  }
  async acquire(now, trigger, requestId='') {
    const token = crypto.randomUUID();
    const row = await this.stmt(`UPDATE engine_control SET lease_token=?,lease_until=?,last_tick_at=?,last_run_at=?,next_run_at=?
      WHERE id=1 AND paused=0 AND lease_until<=? AND next_run_at<=? RETURNING *`, token, now + LEASE_MS,
      new Date(now).toISOString(), new Date(now).toISOString(), now + CADENCE_MS, now, now).first();
    if (!row) return null;
    const lease = {token, epoch: row.epoch, until: row.lease_until};
    const guard = this.controlGuard(lease, now);
    await this.db.batch([
      this.stmt(`INSERT INTO engine_runs(id,trigger,started_at,status,request_id) SELECT ?,?,?,'running',? WHERE ${guard.sql}`,
        token, trigger, new Date(now).toISOString(),requestId, ...guard.args),
      this.stmt(`INSERT INTO job_events(job_id,happened,action,code,detail)
        SELECT id,?,'recovered','lease_expired','Previous execution did not finish before its lease expired.'
        FROM jobs WHERE status='running' AND lease_until<=? AND ${guard.sql}`,
        new Date(now).toISOString(), now, ...guard.args),
      this.stmt(`UPDATE jobs SET status=CASE WHEN attempts<max_attempts THEN 'retry' ELSE 'failed' END,
        not_before=?,updated_at=?,error_code='lease_expired',lease_token='',lease_until=0
        WHERE status='running' AND lease_until<=? AND ${guard.sql}`, now, new Date(now).toISOString(), now, ...guard.args),
      this.stmt(`UPDATE engine_runs SET status='interrupted',finished_at=?,error_code='lease_expired'
        WHERE status='running' AND id!=? AND ${guard.sql}`, new Date(now).toISOString(), token, ...guard.args)
    ]);
    return lease;
  }
  async active(lease, now) {
    const g = this.controlGuard(lease, now);
    return !!await this.stmt(`SELECT 1 AS active WHERE ${g.sql}`, ...g.args).first();
  }
  async enqueue(lease, now, providerReady) {
    const guard = this.controlGuard(lease, now);
    await this.stmt(`UPDATE source_health SET cursor='',cycle=cycle+1,exhausted=0,status='ready'
      WHERE source IN ('nepali','english') AND exhausted=1 AND next_allowed_at<=? AND ${guard.sql}`, now, ...guard.args).run();
    const sources = await this.sources();
    const inserts = [];
    for (const source of sources.filter(s => ['nepali','english'].includes(s.source) && s.status !== 'denied' && !s.exhausted)) {
      const id = await stableId('dictionary', source.source, source.cycle, source.cursor);
      inserts.push(this.stmt(`INSERT OR IGNORE INTO jobs(id,kind,source,payload,status,created_at,updated_at)
        SELECT ?,'dictionary',?,?,'queued',?,? WHERE ${guard.sql}`, id, source.source,
        JSON.stringify({cursor: source.cursor, cycle: source.cycle}), new Date(now).toISOString(), new Date(now).toISOString(), ...guard.args));
    }
    if (providerReady && sources.find(s=>s.source==='namecheap')?.status!=='denied') {
      const domains = await this.all(`SELECT w.domain FROM words w
        LEFT JOIN observations o ON o.domain=w.domain LEFT JOIN leases l ON l.domain=w.domain
        WHERE w.triage!='rejected' AND (l.domain IS NULL OR l.expires<=?)
        AND EXISTS(SELECT 1 FROM meanings m WHERE m.domain=w.domain AND m.accepted=1 AND length(trim(m.definition))>0)
        AND (o.domain IS NULL OR o.checked_at<CASE WHEN o.status IN ('registered','unavailable') THEN ? ELSE ? END)
        AND NOT EXISTS(SELECT 1 FROM jobs j,json_each(j.payload,'$.domains') d
          WHERE j.kind='availability' AND j.status IN ('queued','retry','running') AND d.value=w.domain)
        ORDER BY CASE WHEN EXISTS(SELECT 1 FROM meanings m WHERE m.domain=w.domain AND m.language='Nepali' AND m.accepted=1)
          THEN 0 ELSE 1 END,w.favorite DESC,
          COALESCE((SELECT MAX(m.brand_score) FROM meanings m WHERE m.domain=w.domain AND m.accepted=1),0) DESC,
          length(w.word),w.word LIMIT 5`, new Date(now).toISOString(),
        new Date(now - 7 * 86_400_000).toISOString(), new Date(now - STALE_MS).toISOString());
      if (domains.length) {
        const names = domains.map(x => x.domain);
        const id = await stableId('availability', [...names].sort(), Math.floor(now / STALE_MS));
        inserts.push(this.stmt(`INSERT OR IGNORE INTO jobs(id,kind,source,payload,status,created_at,updated_at)
          SELECT ?,'availability','namecheap',?,'queued',?,? WHERE ${guard.sql}`, id, JSON.stringify({domains: names}),
          new Date(now).toISOString(), new Date(now).toISOString(), ...guard.args));
      }
    }
    if (inserts.length) await this.db.batch(inserts);
  }
  async claim(lease, now, providerReady) {
    const guard = this.controlGuard(lease, now);
    const row = await this.stmt(`SELECT j.* FROM jobs j JOIN source_health s ON s.source=j.source
      WHERE j.status IN ('queued','retry') AND j.not_before<=? AND j.attempts<j.max_attempts AND j.cancel_requested=0
      AND s.status!='denied' AND s.next_allowed_at<=? AND (j.kind!='availability' OR ?=1)
      AND ${guard.sql} ORDER BY CASE j.source WHEN 'nepali' THEN 0 WHEN 'english' THEN 1 ELSE 2 END,j.created_at LIMIT 1`,
      now, now, +providerReady, ...guard.args).first();
    if (!row) return null;
    const claimed = await this.stmt(`UPDATE jobs SET status='running',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=?
      WHERE id=? AND status IN ('queued','retry') AND cancel_requested=0 AND ${guard.sql} RETURNING *`,
      lease.token, lease.until, new Date(now).toISOString(), row.id, ...guard.args).first();
    if (!claimed) return null;
    const g = this.jobGuard(claimed, lease, now);
    await this.db.batch([
      this.stmt(`UPDATE source_health SET last_attempt_at=?,next_allowed_at=? WHERE source=? AND ${g.sql}`,
        new Date(now).toISOString(), now + CADENCE_MS, claimed.source, ...g.args),
      this.stmt(`INSERT INTO job_events(job_id,happened,action,detail) SELECT ?,?,'started',? WHERE ${g.sql}`,
        claimed.id, new Date(now).toISOString(), `Attempt ${claimed.attempts}`, ...g.args)
    ]);
    return claimed;
  }
  jsonInsert(table, fields, rows, guard, conflict = '') {
    // Table/column/guard arguments are constants from application code; row data is a single bound JSON value.
    return this.stmt(`INSERT ${conflict === 'ignore' ? 'OR IGNORE ' : ''}INTO ${table}(${fields.join(',')})
      SELECT ${fields.map(field => `json_extract(x.value,'$.${field}')`).join(',')} FROM json_each(?) x
      WHERE ${guard.sql} ${conflict === 'ignore' ? '' : conflict}`, JSON.stringify(rows), ...guard.args);
  }
  meaningBatchStatements(meanings,guard) {
    const words=meanings.map(m=>({domain:m.domain,word:m.romanization,meaning:m.definition,language:m.language,
      source:m.revision_url,fetched:m.retrieved_at,native:m.native,source_note:`${m.license}. ${m.romanization_status}. ${m.review_note}`}));
    const rows=meanings.map(m=>{const brand=brandSignals(m.romanization,m);return {...m,accepted:1,first_seen_at:m.retrieved_at,definition_status:'dictionary_definition_verified',
      romanization_method:m.romanization_method||'dictionary_spelling',romanization_confidence:m.romanization_confidence??null,
      usage_labels:m.usage_labels||'[]',commonness_status:brand.commonness,brand_score:brand.score,
      brand_suitability:brand.suitability,spelling_friction:brand.friction,brand_reasons:JSON.stringify(brand.reasons),
      reviewed_definition:m.reviewed_definition||''}});
    return [this.jsonInsert('words',['domain','word','meaning','language','source','fetched','native','source_note'],words,guard,
      `ON CONFLICT(domain) DO UPDATE SET meaning=excluded.meaning,source=excluded.source,fetched=excluded.fetched,
        source_note=excluded.source_note WHERE words.language=excluded.language AND words.native=excluded.native`),
      this.jsonInsert('meanings',['id','domain','language','native','definition','romanization','romanization_status','review_actor','review_note',
        'entry_url','revision_url','revision_id','revision_at','retrieved_at','license','origin','accepted','first_seen_at',
        'definition_status','romanization_method','romanization_confidence','usage_labels','commonness_status','brand_score',
        'brand_suitability','spelling_friction','brand_reasons','reviewed_definition'],rows,guard,
        `ON CONFLICT(domain,language,native,entry_url) DO UPDATE SET definition=excluded.definition,
        romanization_status=excluded.romanization_status,review_actor=excluded.review_actor,review_note=excluded.review_note,
        revision_url=excluded.revision_url,revision_id=excluded.revision_id,revision_at=excluded.revision_at,
        retrieved_at=excluded.retrieved_at,license=excluded.license,origin=excluded.origin,accepted=1,
        definition_status=excluded.definition_status,romanization_method=excluded.romanization_method,
        romanization_confidence=excluded.romanization_confidence,usage_labels=excluded.usage_labels,commonness_status=excluded.commonness_status,
        brand_score=excluded.brand_score,brand_suitability=excluded.brand_suitability,
        spelling_friction=excluded.spelling_friction,brand_reasons=excluded.brand_reasons,reviewed_definition=excluded.reviewed_definition`)
    ];
  }
  meaningStatements(meaning, guard) {
    return this.meaningBatchStatements([meaning],guard);
  }
  async commitDictionary(job, batch, lease, now) {
    const guard = this.jobGuard(job, lease, now);
    const statements = [], reviewRows=[], accepted=[];
    if(batch.entries.length)statements.push(this.jsonInsert('dictionary_entries',
      ['id','source','page_id','revision_id','native','language','definition','raw_excerpt','entry_url','revision_url',
        'revision_at','retrieved_at','request_url','license','eligible','reason','usage_labels'],batch.entries,guard,'ignore'));
    for (const entry of batch.entries) {
      if (!entry.eligible) continue;
      if (entry.source === 'nepali') {
        const roman = proposeRomanization(entry.native);
        const automatic = roman.confidence >= 0.9 && roman.issues.length === 0;
        reviewRows.push({word:entry.native,meaning:entry.raw_excerpt,source:entry.revision_url,fetched:entry.retrieved_at,
          entry_id:entry.id,definition:entry.definition,romanization_suggestion:roman.suggestion,romanization_method:roman.method,
          romanization_confidence:roman.confidence,reviewer_type:'automated_rule',definition_status:'dictionary_definition_verified',
          decision:automatic?'rule_reviewed':'pending',reviewed_domain:automatic?roman.suggestion+'.com':'',
          review_note:roman.explanation+' '+roman.issues.join('; ')});
        if (automatic) {
          const meaning = {...entry, domain: roman.suggestion + '.com', romanization: roman.suggestion,
            romanization_status: 'rule_reviewed_practical', romanization_method: roman.method,
            romanization_confidence: roman.confidence, review_actor: 'automated_rule', review_note: roman.explanation,
            origin: 'dictionary_api'};
          meaning.id = await stableId(meaning.domain, meaning.language, meaning.native, meaning.entry_url);
          accepted.push(meaning);
        }
      } else {
        const meaning = {...entry, domain: entry.native + '.com', romanization: entry.native, native: '',
          romanization_status: 'dictionary_spelling', review_actor: 'rule_based_extraction', review_note: 'Plain definition extracted from an explicit English section.',
          origin: 'dictionary_api'};
        meaning.id = await stableId(meaning.domain, meaning.language, meaning.native, meaning.entry_url);
        accepted.push(meaning);
      }
    }
    if(reviewRows.length)statements.push(this.jsonInsert('reviews',['word','meaning','source','fetched','entry_id','definition',
      'romanization_suggestion','romanization_method','romanization_confidence','reviewer_type','definition_status',
      'decision','reviewed_domain','review_note'],reviewRows,guard,`ON CONFLICT(word) DO UPDATE SET meaning=excluded.meaning,
      source=excluded.source,fetched=excluded.fetched,entry_id=excluded.entry_id,definition=excluded.definition,
      romanization_suggestion=excluded.romanization_suggestion,romanization_method=excluded.romanization_method,
      romanization_confidence=excluded.romanization_confidence,reviewer_type=excluded.reviewer_type,
      definition_status=excluded.definition_status,decision=excluded.decision,reviewed_domain=excluded.reviewed_domain,
      review_note=excluded.review_note WHERE reviews.decision='pending'`));
    if(accepted.length){
      const acceptedGuard=job.source==='nepali'?{sql:`${guard.sql} AND EXISTS(SELECT 1 FROM reviews WHERE word=json_extract(x.value,'$.native') AND decision='rule_reviewed')`,args:guard.args}:guard;
      statements.push(...this.meaningBatchStatements(accepted,acceptedGuard));
    }
    statements.push(this.stmt(`UPDATE source_health SET cursor=?,exhausted=?,status=?,failures=0,error_code='',last_success_at=?,next_allowed_at=?
      WHERE source=? AND ${guard.sql}`, batch.nextCursor, +batch.exhausted, batch.exhausted ? 'scan_complete' : 'healthy',
      new Date(now).toISOString(), now + (batch.exhausted ? 7 * 86_400_000 : CADENCE_MS), job.source, ...guard.args));
    const result = {entries: batch.entries.length, eligible: batch.entries.filter(e => e.eligible).length,
      skipped: batch.skipped, reviewRequired: job.source === 'nepali', topicMatched: false};
    statements.push(...this.finishStatements(job, guard, now, 'succeeded', '', result));
    const results=await this.db.batch(statements);
    return (results.at(-1)?.meta?.changes||0)>0;
  }
  observationBatchStatements(rows,guard={sql:'1',args:[]}) {
    return [this.jsonInsert('availability_events',['id','domain','status','checked_at','source_url','evidence','provider','environment',
      'price','currency','period_months','renewal_price','error_code','kind'],rows,guard,'ignore'),
      this.jsonInsert('observations',['domain','status','checked_at','source_url','evidence','provider','price','currency','period_months','kind'],
        rows.filter(r=>r.status!=='transient_error'),guard,`ON CONFLICT(domain) DO UPDATE SET status=excluded.status,
        checked_at=excluded.checked_at,source_url=excluded.source_url,evidence=excluded.evidence,provider=excluded.provider,
        price=excluded.price,currency=excluded.currency,period_months=excluded.period_months,kind=excluded.kind
        WHERE excluded.checked_at>observations.checked_at`)];
  }
  observationStatements(row, id, guard = {sql: '1', args: []}) {
    return [
      this.stmt(`INSERT OR IGNORE INTO availability_events(id,domain,status,checked_at,source_url,evidence,provider,environment,
        price,currency,period_months,renewal_price,error_code,kind) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard.sql}`,
        id, row.domain, row.status, row.checked_at, row.source_url, row.evidence, row.provider, row.environment,
        row.price, row.currency, row.period_months, row.renewal_price, row.error_code, row.kind, ...guard.args),
      this.stmt(`INSERT INTO observations(domain,status,checked_at,source_url,evidence,provider,price,currency,period_months,kind)
        SELECT ?,?,?,?,?,?,?,?,?,? WHERE ?!='transient_error' AND ${guard.sql}
        ON CONFLICT(domain) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at,source_url=excluded.source_url,
        evidence=excluded.evidence,provider=excluded.provider,price=excluded.price,currency=excluded.currency,
        period_months=excluded.period_months,kind=excluded.kind WHERE excluded.checked_at>observations.checked_at`,
        row.domain, row.status, row.checked_at, row.source_url, row.evidence, row.provider, row.price, row.currency,
        row.period_months, row.kind, row.status, ...guard.args)
    ];
  }
  finishStatements(job, guard, now, status, code, result, notBefore = 0, payload = job.payload) {
    return [
      this.stmt(`INSERT INTO job_events(job_id,happened,action,code,detail) SELECT ?,?,?,?,? WHERE ${guard.sql}`,
        job.id, new Date(now).toISOString(), status, code, JSON.stringify(result), ...guard.args),
      this.stmt(`UPDATE jobs SET status=?,error_code=?,result=?,not_before=?,payload=?,updated_at=?,lease_token='',lease_until=0
        WHERE id=? AND ${guard.sql}`, status, code, JSON.stringify(result), notBefore, payload, new Date(now).toISOString(), job.id, ...guard.args)
    ];
  }
  async commitAvailability(job, observations, lease, now, random) {
    const guard = this.jobGuard(job, lease, now);
    const bad = observations.filter(o => o.status === 'transient_error');
    const good = observations.filter(o => o.status !== 'transient_error');
    const rows=[];
    for(const row of observations)rows.push({...row,id:await stableId(job.id,job.attempts,row.domain)});
    const statements = this.observationBatchStatements(rows,guard);
    const status = !bad.length ? 'succeeded' : job.attempts < job.max_attempts ? 'retry' : 'failed';
    const next = bad.length ? now + retryDelay(job.attempts, 0, random) : now + CADENCE_MS;
    statements.push(this.stmt(`UPDATE source_health SET status=?,failures=CASE WHEN ?=0 THEN 0 ELSE failures+1 END,
      error_code=?,next_allowed_at=?,last_success_at=CASE WHEN ?>0 THEN ? ELSE last_success_at END WHERE source='namecheap' AND ${guard.sql}`,
      bad.length ? 'degraded' : 'healthy', bad.length, bad.length ? 'partial_result' : '', next, good.length,
      new Date(now).toISOString(), ...guard.args));
    statements.push(...this.finishStatements(job, guard, now, status, bad.length ? 'partial_result' : '',
      {successful: good.length, missingOrError: bad.length}, next, JSON.stringify({domains: bad.map(o => o.domain)})));
    const results=await this.db.batch(statements);
    return (results.at(-1)?.meta?.changes||0)>0 && status==='succeeded';
  }
  async fail(job, error, lease, now, random) {
    const guard = this.jobGuard(job, lease, now);
    const status = error.denied ? 'blocked' : error.retryable && job.attempts < job.max_attempts ? 'retry' : 'failed';
    const delay = retryDelay(job.attempts, error.retryAfterMs, random);
    await this.db.batch([
      this.stmt(`UPDATE source_health SET status=?,failures=failures+1,error_code=?,next_allowed_at=?
        WHERE source=? AND ${guard.sql}`, error.denied ? 'denied' : 'outage', error.code, now + delay, job.source, ...guard.args),
      ...this.finishStatements(job, guard, now, status, error.code, {retryable: error.retryable, denied: error.denied}, now + delay)
    ]);
  }
  async release(lease, now, completed, failed = false, outcome='') {
    const guard = this.controlGuard(lease, now);
    await this.db.batch([
      this.stmt(`UPDATE engine_runs SET finished_at=?,status=?,jobs_completed=? WHERE id=? AND ${guard.sql}`,
        new Date(now).toISOString(), outcome||(failed ? 'partial' : 'completed'), completed, lease.token, ...guard.args),
      this.stmt(`UPDATE engine_control SET lease_token='',lease_until=0,
        last_success_at=CASE WHEN ?>0 THEN ? ELSE last_success_at END WHERE id=1 AND ${guard.sql}`,
        completed, new Date(now).toISOString(), ...guard.args)
    ]);
  }
  async setPaused(paused, now) {
    const current=await this.control();
    if(!!current.paused===paused)return;
    await this.db.batch([
      this.stmt(`UPDATE engine_control SET paused=?,epoch=epoch+1,lease_token='',lease_until=0,
        next_run_at=CASE WHEN ?=0 THEN 0 ELSE next_run_at END WHERE id=1`, +paused, +paused),
      this.stmt(`UPDATE jobs SET status=CASE WHEN attempts<max_attempts THEN 'retry' ELSE 'failed' END,
        error_code='execution_paused',updated_at=?,lease_token='',lease_until=0 WHERE status='running'`, new Date(now).toISOString()),
      this.stmt(`UPDATE engine_runs SET status='paused',finished_at=? WHERE status='running'`, new Date(now).toISOString()),
      this.stmt(`INSERT INTO job_events(happened,action) VALUES(?,?)`, new Date(now).toISOString(), paused ? 'paused' : 'resumed')
    ]);
  }
  async cancelJob(id, now) {
    const rows = await this.stmt(`UPDATE jobs SET status='cancelled',cancel_requested=1,updated_at=?
      WHERE id=? AND status IN ('queued','retry','running','blocked') RETURNING id`, new Date(now).toISOString(), id).first();
    if (rows) await this.audit('cancelled', '', 'Pending results will be discarded.', id, now);
    return !!rows;
  }
  async dispatchState(job,lease,now){
    const row=await this.stmt(`SELECT c.paused,c.epoch,c.lease_token,c.lease_until,c.availability_enabled,
      j.status,j.cancel_requested FROM engine_control c LEFT JOIN jobs j ON j.id=? WHERE c.id=1`,job.id).first();
    const status=row?.paused?'paused':row?.cancel_requested||row?.status==='cancelled'?'cancelled':
      !row||row.epoch!==lease.epoch||row.lease_token!==lease.token||row.lease_until<=now||row.status!=='running'?'lease_lost':'active';
    return {status,availabilityEnabled:!!row?.availability_enabled};
  }
  async eligibleDomains(domains,now) {
    if(!domains.length)return [];
    const rows=await this.all(`SELECT w.domain FROM words w LEFT JOIN leases l ON l.domain=w.domain
      LEFT JOIN observations o ON o.domain=w.domain WHERE w.domain IN (${domains.map(()=>'?').join(',')})
      AND w.triage!='rejected' AND (l.domain IS NULL OR l.expires<=?)
      AND EXISTS(SELECT 1 FROM meanings m WHERE m.domain=w.domain AND m.accepted=1 AND length(trim(m.definition))>0)
      AND (o.domain IS NULL OR o.checked_at<CASE WHEN o.status IN ('registered','unavailable') THEN ? ELSE ? END)`,
      ...domains,new Date(now).toISOString(),new Date(now-7*86_400_000).toISOString(),new Date(now-STALE_MS).toISOString());
    const eligible=new Set(rows.map(r=>r.domain));
    return domains.filter(d=>eligible.has(d));
  }
  async skipJob(job,lease,now) {
    await this.db.batch(this.finishStatements(job,this.jobGuard(job,lease,now),now,'succeeded','no_eligible_domains',{skipped:true}));
    return false;
  }
  async retryJob(id, now) {
    const job = await this.stmt(`SELECT * FROM jobs WHERE id=? AND status IN ('failed','blocked','cancelled')`, id).first();
    if (!job) return false;
    // An explicit dashboard action is required after a denial. Retrying never changes endpoints or credentials.
    await this.db.batch([
      this.stmt(`UPDATE jobs SET status='queued',attempts=0,cancel_requested=0,error_code='',updated_at=?,not_before=0 WHERE id=?`,
        new Date(now).toISOString(), id),
      this.stmt(`UPDATE source_health SET status='ready',error_code='',next_allowed_at=0 WHERE source=?`, job.source),
      this.stmt(`INSERT INTO job_events(job_id,happened,action,detail) VALUES(?,?,'retry_requested','Explicit dashboard retry of the same configured source.')`, id, new Date(now).toISOString())
    ]);
    return true;
  }
  async importObservations(rows, now) {
    const names=rows.map(r=>r.domain);
    const known=await this.all(`SELECT domain FROM words WHERE domain IN (${names.map(()=>'?').join(',')})`,...names);
    if(known.length!==names.length)throw new PipelineError('unknown_import_domain',{retryable:false});
    const events=[];
    for (const row of rows) {
      const id = await stableId('manual', row.domain, row.checked_at, row.status, row.source_url, row.evidence,
        row.price, row.currency, row.period_months);
      events.push({...row,id});
    }
    const statements=this.observationBatchStatements(events);
    // Historical imports cannot release someone else's current manual lease.
    statements.push(this.stmt(`DELETE FROM leases WHERE EXISTS(SELECT 1 FROM json_each(?) x
      WHERE json_extract(x.value,'$.domain')=leases.domain AND leases.expires<=json_extract(x.value,'$.checked_at'))`,JSON.stringify(rows)));
    await this.db.batch(statements);
    await this.audit('manual_import', '', `${rows.length} dated observations; no external requests.`, null, now);
  }
  async batches(now) {
    const batches=await this.all(`SELECT b.id,b.created_at,b.expires,b.released_at,
      CASE WHEN b.state='released' THEN 'released' WHEN b.expires<=? THEN 'expired' ELSE 'active' END AS state
      FROM manual_batches b UNION ALL SELECT l.batch_id AS id,MIN(l.expires) AS created_at,MAX(l.expires) AS expires,NULL AS released_at,
      CASE WHEN MAX(l.expires)<=? THEN 'expired' ELSE 'active' END AS state FROM leases l
      WHERE NOT EXISTS(SELECT 1 FROM manual_batches b WHERE b.id=l.batch_id) GROUP BY l.batch_id ORDER BY expires DESC LIMIT 10`,
      new Date(now).toISOString(),new Date(now).toISOString());
    const ids=batches.map(b=>b.id);
    const rows=ids.length?await this.all(`SELECT w.*,l.batch_id,l.expires AS lease_expires FROM words w JOIN leases l ON l.domain=w.domain
      WHERE l.batch_id IN (${ids.map(()=>'?').join(',')}) ORDER BY w.word`,...ids):[];
    return batches.map(b=>({...b,words:rows.filter(w=>w.batch_id===b.id)}));
  }
  async reserveBatch(count,requestId,now) {
    const id=crypto.randomUUID(),stamp=new Date(now).toISOString(),expires=new Date(now+12*60_000).toISOString();
    await this.db.batch([
      this.stmt(`INSERT OR IGNORE INTO manual_batches(id,request_id,created_at,expires,requested_count) VALUES(?,?,?,?,?)`,id,requestId,stamp,expires,count),
      this.stmt(`INSERT INTO leases(domain,batch_id,expires) SELECT w.domain,?,? FROM words w
        LEFT JOIN leases l ON l.domain=w.domain LEFT JOIN observations o ON o.domain=w.domain
        WHERE EXISTS(SELECT 1 FROM manual_batches b WHERE b.id=? AND b.state='active')
        AND w.triage!='rejected' AND EXISTS(SELECT 1 FROM meanings m WHERE m.domain=w.domain AND m.accepted=1 AND length(trim(m.definition))>0)
        AND (l.domain IS NULL OR l.expires<=?)
        AND (o.domain IS NULL OR o.checked_at<?) AND NOT EXISTS(SELECT 1 FROM jobs j,json_each(j.payload,'$.domains') d
          WHERE j.status IN ('queued','retry','running') AND j.kind='availability' AND d.value=w.domain)
        ORDER BY CASE w.language WHEN 'Nepali' THEN 0 ELSE 1 END,w.favorite DESC,length(w.word),w.word LIMIT ?
        ON CONFLICT(domain) DO UPDATE SET batch_id=excluded.batch_id,expires=excluded.expires WHERE leases.expires<=?`,
        id,expires,id,stamp,new Date(now-STALE_MS).toISOString(),count,stamp)
    ]);
    const batch=await this.stmt('SELECT * FROM manual_batches WHERE request_id=?',requestId).first();
    const rows=await this.all('SELECT w.* FROM words w JOIN leases l ON l.domain=w.domain WHERE l.batch_id=? ORDER BY w.word',batch.id);
    return {batch_id:batch.id,expires:batch.expires,state:batch.state==='released'?'released':Date.parse(batch.expires)<=now?'expired':'active',words:rows,
      note:'Visible manual review lease only. No registrar request, cart or purchase was performed.'};
  }
  async releaseBatch(id,now) {
    const exists=await this.stmt('SELECT id FROM manual_batches WHERE id=? UNION SELECT batch_id AS id FROM leases WHERE batch_id=? LIMIT 1',id,id).first();
    if(!exists)return false;
    await this.db.batch([
      this.stmt(`INSERT INTO manual_batches(id,request_id,created_at,expires,requested_count,state,released_at)
        VALUES(?,?,?,?,0,'released',?) ON CONFLICT(id) DO UPDATE SET state='released',released_at=COALESCE(manual_batches.released_at,excluded.released_at)`,
        id,'legacy:'+id,new Date(now).toISOString(),new Date(now).toISOString(),new Date(now).toISOString()),
      this.stmt('DELETE FROM leases WHERE batch_id=?',id)
    ]);
    return true;
  }
}
