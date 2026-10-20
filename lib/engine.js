import {RUN_BUDGET_MS, safeError, PipelineError} from './safety.js';
import {readDictionary} from './dictionary.js';
import {checkNamecheap, providerStatus} from './namecheap.js';
import {LabStore} from './store.js';

export async function runTick(env, {trigger = 'manual', requestId='',clock = Date.now, fetcher = fetch, random = Math.random} = {}) {
  if (!env.DB) return {status:'storage_unavailable'};
  if(trigger.startsWith('github_')&&env.EXTERNAL_SCHEDULER_ENABLED!=='true')return {status:'external_scheduler_not_enabled'};
  const store = new LabStore(env.DB);
  const started = clock();
  if (trigger === 'scheduled') await store.scheduledSeen(started);
  if(trigger.startsWith('github_')&&!await store.externalSeen(requestId,trigger,started))return {status:'duplicate_request'};
  if (env.SCHEDULER_ENABLED !== 'true') return {status:'scheduler_disabled'};
  const lease = await store.acquire(started, trigger,requestId);
  if (!lease) return {status:'paused_busy_or_not_due'};
  let completed = 0, failed = false;
  try {
    const control = await store.control();
    const ready = providerStatus(env, control.availability_enabled).ready;
    await store.enqueue(lease, clock(), ready);
    // At most one page per dictionary and one registrar request, in series. Never sleep inside a run.
    for (let i = 0; i < 3 && clock() - started < RUN_BUDGET_MS - 8000; i++) {
      // claim() includes the execution fence, so it also stops paused, cancelled or expired executions.
      const job = await store.claim(lease, clock(), ready);
      if (!job) break;
      try {
        const payload = JSON.parse(job.payload);
        let succeeded=false;
        if (job.kind === 'dictionary') {
          const batch = await readDictionary(job.source, payload.cursor, {fetcher, now:clock()});
          succeeded=await store.commitDictionary(job, batch, lease, clock());
        } else if (job.kind === 'availability') {
          // Recheck controls at the last point before sending any registrar request.
          const latest = await store.control();
          if (!providerStatus(env, latest.availability_enabled).ready) throw new PipelineError('provider_paused', {retryable:false});
          const eligible=await store.eligibleDomains(payload.domains,clock());
          if(!eligible.length){await store.skipJob(job,lease,clock());continue;}
          const observations = await checkNamecheap(eligible, env, {fetcher,now:clock()});
          succeeded=await store.commitAvailability(job, observations, lease, clock(), random);
          if (observations.some(o => o.status === 'transient_error')) failed = true;
        } else throw new PipelineError('unknown_job_kind', {retryable:false});
        if(succeeded)completed++;
      } catch (error) {
        failed = true;
        await store.fail(job, safeError(error), lease, clock(), random);
      }
    }
    return {status:failed ? 'partial' : 'completed',completed,run_id:lease.token};
  } catch {
    // Keep an interrupted lease for crash recovery if persistence itself failed. Never log the exception.
    failed = true;
    return {status:'execution_error',completed};
  } finally { await store.release(lease, clock(), completed, failed); }
}
