import {DOMAIN_PATTERN, CADENCE_MS, STALE_MS, PipelineError, cleanMeaning, normalize, validReview, plainDefinition,
  safeHttpsUrl, safeError, validateImport, boundedText, stableId} from './lib/safety.js';
import {suggestedDefinition} from './lib/dictionary.js';
import {LabStore} from './lib/store.js';
import {providerStatus} from './lib/namecheap.js';
import {runTick} from './lib/engine.js';
import {candidates} from './lib/candidates.js';

export {cleanMeaning, normalize, validReview, suggestedDefinition};

const responseJson = (data, status = 200) => new Response(JSON.stringify(data), {status,headers:{
  'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'self'"}});

function privateDeployment(env, url) {
  if (env.LOCAL_DEV === 'true' && url && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)) return true;
  // Set this attestation only after verifying the existing platform's owner-only authentication gate.
  // Request headers are never accepted as proof of identity. The default deployment fails closed.
  return env.ACCESS_MODE === 'platform' && env.PRIVATE_DEPLOYMENT_CONFIRMED === 'true';
}

async function requestBody(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new PipelineError('json_required',{retryable:false});
  try {
    const body = JSON.parse(await boundedText(request, 100_000));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error();
    return body;
  } catch (error) { if (error instanceof PipelineError) throw error; throw new PipelineError('invalid_json',{retryable:false}); }
}

async function submitReview(store,body,now) {
  if (!validReview(body) || !['owner','assistant'].includes(body.reviewer)
      || (body.action === 'approve' && (typeof body.method !== 'string' || !body.method.trim() || body.method.length > 200
        || body.note.trim().length < 5 || !Number.isFinite(body.confidence) || body.confidence < 0.9 || body.confidence > 1))) {
    return responseJson({error:'explicit_reviewer_method_confidence_and_source_review_required'},400);
  }
  const review = await store.stmt('SELECT * FROM reviews WHERE word=?',body.word).first();
  if (!review) return responseJson({error:'source_entry_not_found'},404);
  if (body.action === 'reject') {
    await store.db.batch([store.stmt("UPDATE reviews SET decision='rejected',review_note=?,reviewer_type=? WHERE word=?",body.note,body.reviewer,body.word),
      store.stmt("UPDATE meanings SET accepted=0 WHERE language='Nepali' AND native=?",body.word),
      store.stmt("INSERT INTO job_events(happened,action,detail) VALUES(?,'dictionary_rejected',?)",new Date(now).toISOString(),`${body.word}; reviewer=${body.reviewer}; ${body.note}`)]);
    return responseJson({ok:true,decision:'rejected',reviewer:body.reviewer});
  }
  const entry = await store.stmt("SELECT * FROM dictionary_entries WHERE id=? AND eligible=1 AND source='nepali'",review.entry_id).first();
  if (!entry || !entry.definition || !safeHttpsUrl(entry.revision_url,['ne.wiktionary.org'],p => p.startsWith('/wiki/'))) {
    return responseJson({error:'structured_source_revision_required',note:'Fetch historical review entries with exact revision provenance before promotion.'},409);
  }
  const meaning = {...entry,domain:body.romanization+'.com',romanization:body.romanization,
    definition:entry.definition,reviewed_definition:plainDefinition(body.meaning),romanization_status:body.reviewer+'_reviewed_practical',
    romanization_method:body.method,romanization_confidence:body.confidence,review_actor:body.reviewer,
    review_note:body.note.trim(),origin:'dictionary_review'};
  meaning.id = await stableId(meaning.domain,meaning.language,meaning.native,meaning.entry_url);
  await store.db.batch([...store.meaningStatements(meaning,{sql:'1',args:[]}),
    store.stmt("UPDATE reviews SET decision=?,reviewed_domain=?,review_note=?,reviewer_type=?,romanization_suggestion=?,romanization_method=?,romanization_confidence=? WHERE word=?",
      body.reviewer+'_reviewed',meaning.domain,body.note,body.reviewer,body.romanization,body.method,body.confidence,body.word),
    store.stmt("INSERT INTO job_events(happened,action,detail) VALUES(?,'dictionary_reviewed',?)",new Date(now).toISOString(),
      `${body.word} → ${meaning.domain}; reviewer=${body.reviewer}; practical spelling, not standardized or source-attested. ${body.note}`)]);
  return responseJson({ok:true,domain:meaning.domain,decision:body.reviewer+'_reviewed',reviewer:body.reviewer});
}

export function createWorker({html = '', client = '', clock = Date.now, fetcher = fetch} = {}) {
  return {
    async scheduled(controller, env, ctx) {
      if (!privateDeployment(env)) return;
      const work = runTick(env,{trigger:'scheduled',clock,fetcher});
      if (ctx?.waitUntil) ctx.waitUntil(work);
      else await work;
    },
    async fetch(request,env) {
      const url = new URL(request.url), path = url.pathname, now = clock();
      if (!privateDeployment(env,url)) return responseJson({error:'private_deployment_not_confirmed'},503);
      if (path === '/' && request.method === 'GET') return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8',
        'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
        'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'self'"}});
      if (path === '/app.js' && request.method === 'GET') return new Response(client,{headers:{'Content-Type':'text/javascript; charset=utf-8',
        'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
      if (!path.startsWith('/api/')) return responseJson({error:'not_found'},404);
      if (!env.DB) return responseJson({error:'persistent_storage_unavailable'},503);
      if (!['GET','POST'].includes(request.method)) return responseJson({error:'method_not_allowed'},405);
      if (request.method === 'POST' && ((request.headers.get('origin') && request.headers.get('origin') !== url.origin)
          || request.headers.get('sec-fetch-site') === 'cross-site')) return responseJson({error:'origin_rejected'},403);
      const store = new LabStore(env.DB);
      try {
        if (path === '/api/state' && request.method === 'GET') {
          const [control,sources,jobs,events,runs,reviews,history,totals] = await Promise.all([
            store.control(),store.sources(),store.all('SELECT * FROM jobs ORDER BY updated_at DESC,id LIMIT 40'),
            store.all('SELECT * FROM job_events ORDER BY id DESC LIMIT 60'),store.all('SELECT * FROM engine_runs ORDER BY started_at DESC LIMIT 20'),
            store.all("SELECT * FROM reviews ORDER BY CASE WHEN decision='pending' THEN 0 ELSE 1 END,fetched DESC LIMIT 60"),
            store.all('SELECT * FROM history ORDER BY id DESC LIMIT 40'),
            store.stmt(`SELECT (SELECT COUNT(*) FROM words) AS words,(SELECT COUNT(*) FROM words WHERE favorite=1) AS saved,
              (SELECT COUNT(DISTINCT domain) FROM meanings WHERE accepted=1) AS verified,
              (SELECT COUNT(*) FROM reviews WHERE decision='pending') AS pending_reviews`).first()
          ]);
          const enabled = env.SCHEDULER_ENABLED === 'true';
          const recent = !!control.last_scheduled_at && now - Date.parse(control.last_scheduled_at) < 3 * CADENCE_MS;
          const recentExternal=!!control.last_external_tick_at&&now-Date.parse(control.last_external_tick_at)<15*60_000;
          return responseJson({control,sources,jobs,events,engineRuns:runs,reviews:reviews.map(r => ({...r,
            suggested_definition:r.definition || suggestedDefinition(r.meaning)})),history,totals,
            provider:providerStatus(env,control.availability_enabled),serverTime:new Date(now).toISOString(),
            scheduler:{enabled,paused:!!control.paused,cadenceMs:CADENCE_MS,scheduledEventObservedRecently:recent,
              status:!enabled ? 'not_enabled' : control.paused ? 'paused' : recent ? 'recent_scheduled_event' : recentExternal?'recent_external_request':'schedule_not_verified',
              lastScheduledEvent:control.last_scheduled_at,nextEligibleAt:control.paused || !enabled ? null : new Date(Math.max(now,control.next_run_at)).toISOString(),
              lastExternalRequest:control.last_external_tick_at,lastExternalEvent:control.last_external_event,
              note:'Next eligible time is an estimate. A received scheduled event confirms only that the cron invoked this Worker.'}});
        }
        if(path==='/api/engine/status'&&request.method==='GET')return responseJson({control:await store.control(),
          runs:await store.all('SELECT id,trigger,request_id,started_at,finished_at,status,jobs_completed,error_code FROM engine_runs ORDER BY started_at DESC LIMIT 5'),
          provider:providerStatus(env,(await store.control()).availability_enabled)});
        if(path==='/api/batches'&&request.method==='GET')return responseJson({batches:await store.batches(now)});
        if (path === '/api/candidates' && request.method === 'GET') return responseJson(await candidates(store,url.searchParams,now));
        if (path === '/api/provider' && request.method === 'GET') return responseJson(providerStatus(env,(await store.control()).availability_enabled));
        if (path === '/api/observations' && request.method === 'GET') {
          const domain = url.searchParams.get('domain');
          if (!DOMAIN_PATTERN.test(domain)) return responseJson({error:'invalid_domain'},400);
          return responseJson({observations:await store.all('SELECT * FROM availability_events WHERE domain=? ORDER BY checked_at DESC LIMIT 100',domain)});
        }
        if (request.method !== 'POST') return responseJson({error:'not_found'},404);
        const body = await requestBody(request);
        if (path === '/api/engine/control') {
          if (typeof body.paused !== 'boolean' || Object.keys(body).some(k => k !== 'paused')) return responseJson({error:'invalid_control'},400);
          await store.setPaused(body.paused,now);
          return responseJson({ok:true,paused:body.paused});
        }
        if (path === '/api/engine/run') return responseJson(await runTick(env,{trigger:'manual',clock,fetcher}));
        if(path==='/api/engine/tick') {
          if(env.EXTERNAL_SCHEDULER_ENABLED!=='true')return responseJson({error:'external_scheduler_not_enabled'},409);
          if(!/^\d{1,30}:\d{1,6}$/.test(body.request_id)||!['schedule','workflow_dispatch'].includes(body.event)
            ||Object.keys(body).some(k=>!['request_id','event'].includes(k)))return responseJson({error:'invalid_external_tick'},400);
          return responseJson(await runTick(env,{trigger:body.event==='schedule'?'github_schedule':'github_dispatch',requestId:body.request_id,clock,fetcher}));
        }
        if (path === '/api/jobs/cancel' || path === '/api/jobs/retry') {
          if (!/^[a-f0-9]{64}$/.test(body.id)) return responseJson({error:'invalid_job'},400);
          const ok = path.endsWith('/cancel') ? await store.cancelJob(body.id,now) : await store.retryJob(body.id,now);
          return responseJson({ok},ok ? 200 : 409);
        }
        if (path === '/api/provider') {
          if (typeof body.enabled !== 'boolean' || Object.keys(body).some(k => k !== 'enabled')) return responseJson({error:'credentials_must_use_deployment_secrets'},400);
          const provider = providerStatus(env,body.enabled);
          if (body.enabled && !provider.ready) return responseJson({error:'provider_not_ready',provider},409);
          await env.DB.batch([store.stmt('UPDATE engine_control SET availability_enabled=? WHERE id=1',+body.enabled),
            store.stmt('INSERT INTO job_events(happened,action) VALUES(?,?)',new Date(now).toISOString(),body.enabled ? 'provider_enabled' : 'provider_paused')]);
          return responseJson({ok:true,provider});
        }
        if (path === '/api/refresh') {
          if (!['nepali','english'].includes(body.source)) return responseJson({error:'invalid_source'},400);
          if (env.SCHEDULER_ENABLED !== 'true') return responseJson({error:'scheduler_not_enabled'},409);
          const source = await store.stmt('SELECT * FROM source_health WHERE source=?',body.source).first();
          if (source.status === 'denied') return responseJson({error:'source_access_denied',note:'Resolve access before explicitly retrying the blocked job.'},409);
          if (source.exhausted) return responseJson({status:'scan_complete',nextScanAt:new Date(source.next_allowed_at).toISOString()});
          const id = await stableId('dictionary',source.source,source.cycle,source.cursor);
          await store.stmt(`INSERT OR IGNORE INTO jobs(id,kind,source,payload,status,created_at,updated_at)
            VALUES(?,'dictionary',?,?,'queued',?,?)`,id,body.source,JSON.stringify({cursor:source.cursor,cycle:source.cycle}),
            new Date(now).toISOString(),new Date(now).toISOString()).run();
          return responseJson({status:'queued',job_id:id,topicMatched:false,note:'Dictionary enumeration has no topic-matching claim.'},202);
        }
        if (path === '/api/review') return await submitReview(store,body,now);
        if (path === '/api/observations') {
          const rows = validateImport(body.observations,now);
          await store.importObservations(rows,now);
          return responseJson({ok:true,count:rows.length});
        }
        if (path === '/api/triage' || path === '/api/favorite') {
          if (!DOMAIN_PATTERN.test(body.domain)) return responseJson({error:'invalid_domain'},400);
          if (!await store.stmt('SELECT domain FROM words WHERE domain=?',body.domain).first()) return responseJson({error:'domain_not_found'},404);
          if (path.endsWith('favorite')) {
            if (typeof body.favorite !== 'boolean') return responseJson({error:'invalid_favorite'},400);
            await store.stmt('UPDATE words SET favorite=? WHERE domain=?',+body.favorite,body.domain).run();
          } else {
            if (!['new','shortlist','watchlist','rejected'].includes(body.triage) || typeof body.reason !== 'string' || body.reason.length > 500) return responseJson({error:'invalid_triage'},400);
            await env.DB.batch([store.stmt('UPDATE words SET triage=?,reason=?,favorite=? WHERE domain=?',body.triage,body.reason,+(body.triage==='shortlist'),body.domain),
              store.stmt('INSERT INTO history(happened,action,detail) VALUES(?,?,?)',new Date(now).toISOString(),'Triage',`${body.domain}: ${body.triage}; ${body.reason}`)]);
          }
          return responseJson({ok:true});
        }
        if (path === '/api/next-batch') {
          const count = body.count ?? 20;
          if (!Number.isInteger(count) || count < 1 || count > 20||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(body.request_id)) return responseJson({error:'invalid_batch_count_or_request_id'},400);
          return responseJson(await store.reserveBatch(count,body.request_id,now));
        }
        if(path==='/api/batches/release') {
          if(typeof body.batch_id!=='string'||body.batch_id.length>100)return responseJson({error:'invalid_batch_id'},400);
          const ok=await store.releaseBatch(body.batch_id,now);return responseJson({ok},ok?200:404);
        }
        return responseJson({error:'not_found'},404);
      } catch (error) {
        const safe = safeError(error);
        return responseJson({error:safe.code},safe.code === 'response_too_large' ? 413 : error instanceof PipelineError ? 400 : 500);
      }
    }
  };
}

export default createWorker({html:typeof HTML === 'string' ? HTML : '',client:typeof CLIENT === 'string' ? CLIENT : ''});
