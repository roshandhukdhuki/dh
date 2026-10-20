import {CADENCE_MS, safeError, PipelineError} from './safety.js';
import {executionProfile} from './profiles.js';
import {readDictionary} from './dictionary.js';
import {checkNamecheap, providerStatus} from './namecheap.js';
import {LabStore} from './store.js';

export async function runTick(env, {trigger = 'manual',requestId='',scheduledAt,clock = Date.now, fetcher = fetch, random = Math.random} = {}) {
  if (!env.DB) return {status:'storage_unavailable'};
  if(trigger.startsWith('github_')&&env.EXTERNAL_SCHEDULER_ENABLED!=='true')return {status:'external_scheduler_not_enabled'};
  const store = new LabStore(env.DB);
  const started = clock();
  const profile=executionProfile(env);
  if (trigger === 'scheduled') await store.scheduledSeen(started);
  if(trigger.startsWith('github_')&&!await store.externalSeen(requestId,trigger,started))return {status:'duplicate_request'};
  if (env.SCHEDULER_ENABLED !== 'true') return {status:'scheduler_disabled'};
  const nextRunAt=trigger==='scheduled'&&Number.isFinite(scheduledAt)?Math.max(started+1000,(Math.floor(scheduledAt/CADENCE_MS)+1)*CADENCE_MS):started+CADENCE_MS;
  const lease = await store.acquire(started, trigger,requestId,nextRunAt);
  if (!lease) return {status:'paused_busy_or_not_due'};
  let completed = 0, failed = false,outcome='';
  try {
    const control = await store.control();
    if(profile.dailyTickCap&&!await store.reserveDailyTick(started,profile.dailyTickCap)){
      await store.markRunBudget(lease,clock());
      outcome='daily_budget_reached';
      return {status:outcome,completed:0,run_id:lease.token};
    }
    const ready = !profile.registrarDisabled&&providerStatus(env, control.availability_enabled).ready;
    await store.enqueue(lease, clock(), ready);
    for (let i=0;i<profile.maxJobs&&clock()-started<profile.wallTimeBudgetMs-8000;i++) {
      // claim() includes the execution fence, so it also stops paused, cancelled or expired executions.
      const preferred=profile.name==='cloudflare-free'&&Math.floor((scheduledAt??started)/CADENCE_MS)%3===2?'english':'nepali';
      const job = await store.claim(lease, clock(), ready,preferred);
      if (!job) break;
      try {
        const payload = JSON.parse(job.payload);
        let succeeded=false;
        if (job.kind === 'dictionary') {
          const dispatch=await store.dispatchState(job,lease,clock());
          if(dispatch.status!=='active'){outcome=dispatch.status;return {status:outcome,completed,run_id:lease.token};}

          const batch = await readDictionary(job.source,payload.cursor,{fetcher,now:clock(),limit:profile.dictionaryLimit,
            maxResponseBytes:profile.maxResponseBytes,maxTextChars:profile.maxTextChars});
          succeeded=await store.commitDictionary(job, batch, lease, clock());
        } else if (job.kind === 'availability') {
          // Recheck controls at the last point before sending any registrar request.
          const eligible=await store.eligibleDomains(payload.domains,clock());
          const dispatch=await store.dispatchState(job,lease,clock());
          if(dispatch.status!=='active'){outcome=dispatch.status;return {status:outcome,completed,run_id:lease.token};}
          if (!providerStatus(env, dispatch.availabilityEnabled).ready) throw new PipelineError('provider_paused', {retryable:false});
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
  } finally { await store.release(lease, clock(), completed, failed,outcome); }
}
