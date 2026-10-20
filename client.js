let view = {state:null,words:[],offset:0,nextOffset:null,total:0,batches:[],selectedBatch:sessionStorage.getItem('artha.selectedBatch')||''};
let searchTimer, queryVersion = 0;
const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const utc = value => !value ? 'Never' : !Number.isFinite(new Date(value).getTime()) ? 'Invalid retained timestamp' : new Date(value).toISOString().replace('T',' ').replace('.000Z',' UTC').replace('Z',' UTC');
const readable = value => String(value || 'unknown').replace(/_/g,' ');
function message(text,error=false) { $('message').textContent=text; $('message').classList.toggle('error',error); }

async function api(path,body) {
  const response = await fetch('/api/'+path,body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data = await response.json();
  if (!response.ok) throw Error(readable(data.error)+(data.note ? '. '+data.note : ''));
  return data;
}
function sourceLink(url,label) {
  try { const value = new URL(url);
    if (value.protocol !== 'https:' || value.username || value.password || value.port ||
        !['ne.wiktionary.org','en.wiktionary.org','api.datamuse.com','datamuse.com','namecheap.com','www.namecheap.com','api.namecheap.com'].includes(value.hostname)) return '';
    return `<a href="${escapeHtml(value.href)}" target="_blank" rel="noreferrer">${escapeHtml(label)} ↗</a>`;
  } catch { return ''; }
}

function renderOperations() {
  const {state} = view;
  if (!state) return;
  $('verifiedCount').textContent=state.totals.verified;
  $('historicalCount').textContent=`${state.totals.words-state.totals.verified} historical names preserved`;
  $('savedCount').textContent=state.totals.saved;
  $('providerName').textContent=readable(state.provider.status);
  $('engineBadge').textContent=readable(state.scheduler.status);
  $('engineBadge').classList.toggle('warn',state.scheduler.status!=='recent_scheduled_event');
  $('engineTimes').innerHTML=[['Last scheduled event',state.scheduler.lastScheduledEvent],['Last execution',state.control.last_run_at],
    ['Last successful job run',state.control.last_success_at],['Next eligible work',state.scheduler.nextEligibleAt],
    ['Last external request',state.scheduler.lastExternalRequest]]
    .map(([label,value])=>`<p>${label}<br><b>${escapeHtml(utc(value))}</b></p>`).join('');
  $('engineNote').textContent=state.scheduler.note;
  $('toggleEngine').textContent=state.scheduler.paused?'Resume discovery':'Pause discovery';
  $('runEngine').disabled=state.scheduler.paused||!state.scheduler.enabled;
  const providerHealth=state.sources.find(s=>s.source==='namecheap');
  $('providerStatus').innerHTML=`<b>${escapeHtml(readable(state.provider.status))}</b> · ${escapeHtml(state.provider.mode)}<ul>${state.provider.blockers.map(b=>`<li>${escapeHtml(b)}</li>`).join('')}</ul><p>Provider health: ${escapeHtml(state.provider.configured?readable(providerHealth.status):'not configured; no check attempted')}<br>Last attempt ${escapeHtml(utc(providerHealth.last_attempt_at))}<br>Last successful request ${escapeHtml(utc(providerHealth.last_success_at))}${providerHealth.error_code?'<br>Error: '+escapeHtml(readable(providerHealth.error_code)):''}</p>`;
  $('toggleProvider').textContent=state.provider.enabled?'Pause provider checks':'Enable provider checks';
  $('toggleProvider').disabled=!state.provider.enabled&&(!state.provider.configured||state.provider.mode!=='production');
  $('sources').innerHTML=state.sources.filter(s=>s.source!=='namecheap').sort((a,b)=>a.source==='nepali'?-1:1).map(s=>`<div class="source"><b>${s.source==='nepali'?'नेपाली · Nepali':'English'}</b> <span class="chip ${['denied','outage'].includes(s.status)?'warn':''}">${escapeHtml(readable(s.status))}</span><p class="small">Last attempt ${escapeHtml(utc(s.last_attempt_at))}<br>Last success ${escapeHtml(utc(s.last_success_at))}<br>Next permitted ${escapeHtml(s.next_allowed_at?utc(s.next_allowed_at):'When due')}${s.error_code?'<br>Error: '+escapeHtml(readable(s.error_code)):''}</p><button class="secondary queue-source" data-source="${s.source}" ${!state.scheduler.enabled||s.status==='denied'?'disabled':''}>Queue ${s.source==='nepali'?'Nepali':'English'} page</button><p class="small">${sourceLink('https://'+(s.source==='nepali'?'ne':'en')+'.wiktionary.org/','Wiktionary · CC BY-SA')}</p></div>`).join('');
  $('jobs').innerHTML=state.jobs.map(j=>`<div class="job"><b>${escapeHtml(j.source)}</b> <span class="chip ${['failed','blocked'].includes(j.status)?'warn':''}">${escapeHtml(j.status)}</span><div class="small">${escapeHtml(j.kind)} · attempt ${j.attempts}/${j.max_attempts}<br>${escapeHtml(utc(j.updated_at))}${j.error_code?'<br>'+escapeHtml(readable(j.error_code)):''}${['queued','retry'].includes(j.status)?'<br>Eligible '+escapeHtml(utc(j.not_before||Date.now())):''}</div><div class="row">${['queued','retry','running','blocked'].includes(j.status)?`<button class="secondary job-action" data-id="${j.id}" data-action="cancel">Cancel</button>`:''}${['failed','blocked','cancelled'].includes(j.status)?`<button class="secondary job-action" data-id="${j.id}" data-action="retry">Retry</button>`:''}</div></div>`).join('')||'<p class="small">No jobs yet. Discovery starts paused after migration.</p>';
  for (const button of document.querySelectorAll('.queue-source')) button.onclick=()=>act(button,async()=>{
    const data=await api('refresh',{source:button.dataset.source});message(data.note||readable(data.status));await loadStatus(false);
  });
  for (const button of document.querySelectorAll('.job-action')) button.onclick=()=>act(button,async()=>{
    await api('jobs/'+button.dataset.action,{id:button.dataset.id});message('Job '+button.dataset.action+' recorded.');await loadStatus(false);
  });
  $('history').innerHTML=[...state.events.map(e=>({time:e.happened,text:`${e.action}${e.code?' · '+readable(e.code):''}: ${e.detail}`})),
    ...state.history.map(h=>({time:h.happened,text:h.action+': '+h.detail}))].sort((a,b)=>b.time.localeCompare(a.time))
    .map(e=>`<p class="small">${escapeHtml(utc(e.time))} · ${escapeHtml(e.text)}</p>`).join('')||'<p class="small">No recorded activity.</p>';
}

function meaningHtml(m) {
  return `<div class="meaning"><b>${escapeHtml(m.language)}${m.native?' · '+escapeHtml(m.native):''}</b><p>${escapeHtml(m.definition)}</p>${m.reviewed_definition?'<p class="small">Reviewer meaning / translation (separate from source text): '+escapeHtml(m.reviewed_definition)+'</p>':''}<div class="small">${escapeHtml(readable(m.definition_status))}<br>Spelling: ${escapeHtml(m.romanization)} · ${escapeHtml(readable(m.romanization_status))}<br>Reviewer: ${escapeHtml(readable(m.review_actor||'unattributed legacy'))}${m.romanization_method?'<br>Method: '+escapeHtml(m.romanization_method):''}${m.romanization_confidence!=null?'<br>Reviewer/rule confidence: '+escapeHtml(m.romanization_confidence)+' (not measured accuracy)':''}<br>${escapeHtml(m.review_note)}<br>${escapeHtml(m.license)}<br>Retrieved ${escapeHtml(utc(m.retrieved_at))}${m.revision_at?'<br>Revision dated '+escapeHtml(utc(m.revision_at)):''}<br>${sourceLink(m.revision_url,'Exact definition / attribution')}</div></div>`;
}

function renderCards() {
  $('empty').classList.toggle('hide',view.words.length>0);
  $('cards').innerHTML=view.words.map(w=>{
    const accepted=w.meanings.filter(m=>m.accepted===1),shown=accepted.length?accepted:w.meanings;
    const o=w.observation,last=w.last_attempt;
    const price=o&&o.price!=null ? `${o.price} ${o.currency||'(currency not supplied)'}${o.period_months?' / '+o.period_months+' months':' · period not supplied'}` : 'Price not supplied';
    return `<article class="card"><div class="cardhead"><span class="domain">${escapeHtml(w.domain)}</span><button class="star" data-domain="${w.domain}" aria-label="${w.favorite?'Unsave':'Save'} ${w.domain}">${w.favorite?'★':'☆'}</button></div><span class="chip">${w.word.length===4?'4':w.word.length===5?'5':'6–10'} LETTER GROUP</span><span class="chip ${accepted.length?'':'warn'}">${accepted.length?'Accepted dictionary evidence':'Historical research'}</span>${shown.slice(0,1).map(m=>`<p class="meaning"><b>${escapeHtml(m.native||m.language)}</b> · ${escapeHtml(m.definition)}</p>`).join('')}<div><span class="chip ${w.quality.suitability==='promising_signals'?'':'warn'}">${escapeHtml(readable(w.quality.suitability))}</span>${w.quality.tags.map(t=>`<span class="chip" title="${escapeHtml(t.explanation)}">${escapeHtml(t.tag)}</span>`).join('')}</div><p class="small">${escapeHtml(w.quality.spelling)}<br>Commonness: ${escapeHtml(readable(w.quality.commonness))}<br>Spelling friction: ${escapeHtml(w.quality.friction)} · pronunciation: heuristic only<br>${escapeHtml(w.quality.pronunciation)}</p><details><summary class="small">Brand signal score ${w.quality.score}/100 · explain</summary><p class="small">${escapeHtml(w.quality.scoreExplanation)} ${escapeHtml(w.quality.caveat)}</p>${w.quality.tags.map(t=>`<p class="small">${escapeHtml(t.tag)}: ${escapeHtml(t.explanation)} ${escapeHtml(t.useCase)}.</p>`).join('')}</details><label>Research stage<select class="triage" data-domain="${w.domain}">${['new','shortlist','watchlist','rejected'].map(s=>`<option value="${s}" ${w.triage===s?'selected':''}>${s}</option>`).join('')}</select></label><label>Decision reason<input class="reason" data-domain="${w.domain}" value="${escapeHtml(w.reason)}" maxlength="500"></label><button class="save-decision secondary" data-domain="${w.domain}">Save decision</button><hr><span class="chip ${!o||w.stale?'warn':''}">${o?escapeHtml(readable(o.status))+(w.stale?' · stale':' · dated'):'Availability unknown'}</span><p class="small">${escapeHtml(price)}<br>Last successful check ${escapeHtml(utc(w.last_successful_check))}${o?'<br>Observed '+escapeHtml(utc(o.checked_at))+' · '+escapeHtml(o.provider)+'<br>'+escapeHtml(o.evidence)+'<br>'+sourceLink(o.source_url,'Observation source'):''}${last?.status==='transient_error'?'<br><b>Latest attempt failed: '+escapeHtml(readable(last.error_code))+'</b> · '+escapeHtml(utc(last.checked_at)):''}<br>Final checkout and taxes unconfirmed.</p><details><summary class="small">${w.meanings.length} retained meaning/source record${w.meanings.length===1?'':'s'}</summary>${w.meanings.map(meaningHtml).join('')}</details></article>`;
  }).join('');
  $('previous').disabled=view.offset===0;$('next').disabled=view.nextOffset==null;
  $('pageStatus').textContent=view.total?`${view.offset+1}–${view.offset+view.words.length} of ${view.total}`:'0 matching names';
  for (const button of document.querySelectorAll('.star')) button.onclick=()=>act(button,async()=>{
    const word=view.words.find(w=>w.domain===button.dataset.domain);await api('favorite',{domain:word.domain,favorite:!word.favorite});await loadAll(false);
  });
  for (const button of document.querySelectorAll('.save-decision')) button.onclick=()=>act(button,async()=>{
    const domain=button.dataset.domain;await api('triage',{domain,triage:document.querySelector(`.triage[data-domain="${domain}"]`).value,reason:document.querySelector(`.reason[data-domain="${domain}"]`).value});message('Decision saved.');await loadAll(false);
  });
}

function renderReviews() {
  $('reviewCount').textContent=view.state.totals.pending_reviews+' pending';
  $('reviews').innerHTML=view.state.reviews.map((r,i)=>`<div class="review"><b>${escapeHtml(r.word)}</b> <span class="chip ${r.decision==='pending'?'warn':''}">${escapeHtml(readable(r.decision))}</span><p class="meaning">${escapeHtml(r.suggested_definition||'No plain definition extracted; promotion is blocked.')}</p><p class="small">Definition: ${escapeHtml(readable(r.definition_status))}<br>Suggested spelling: ${escapeHtml(r.romanization_suggestion||'None')} · method ${escapeHtml(r.romanization_method||'unattributed legacy')} · confidence ${r.romanization_confidence??'unknown'}<br>Reviewer: ${escapeHtml(readable(r.reviewer_type))}<br>${escapeHtml(r.review_note)}<br>${sourceLink(r.source,'Original source / revision')} · retrieved ${escapeHtml(utc(r.fetched))}</p><details><summary class="small">Source excerpt</summary><pre>${escapeHtml(r.meaning)}</pre></details>${r.decision==='pending'?`<div class="reviewform"><label>Reviewer attribution<select id="reviewer-${i}" required><option value="">Choose the actual reviewer</option><option value="assistant">Assistant review</option><option value="owner">Owner review</option></select></label><label>Practical romanization (4–10 lowercase letters)<input id="roman-${i}" value="${escapeHtml(r.romanization_suggestion)}" pattern="[a-z]{4,10}" maxlength="10"></label><label>Reviewer meaning / translation (source text is retained separately)<textarea id="definition-${i}" maxlength="1000">${escapeHtml(r.suggested_definition)}</textarea></label><label>Method and spelling considerations<input id="method-${i}" maxlength="200" value="${escapeHtml(r.romanization_method)}"></label><label>Reviewer confidence (judgment, minimum 0.90)<input id="confidence-${i}" type="number" step="0.01" min="0.90" max="1" value="0.90"></label><label>Explain the source and spelling review<input id="note-${i}" maxlength="500" placeholder="Why this meaning and practical spelling are supported"></label><label><input id="confirmed-${i}" type="checkbox"> The selected reviewer checked the source meaning and practical spelling. This does not claim a standardized or source-attested romanization.</label><div class="row"><button class="review-action" data-index="${i}" data-action="approve">Accept practical candidate</button><button class="review-action secondary" data-index="${i}" data-action="reject">Reject entry</button></div></div>`:`<p class="small">${escapeHtml(r.reviewed_domain)} · Resolved decisions are preserved on refresh.</p>`}</div>`).join('')||'<p class="small">No source entries yet.</p>';
  for (const button of document.querySelectorAll('.review-action')) button.onclick=()=>act(button,async()=>{
    const i=+button.dataset.index;const result=await api('review',{word:view.state.reviews[i].word,action:button.dataset.action,
      reviewer:$('reviewer-'+i).value,romanization:$('roman-'+i).value,meaning:$('definition-'+i).value,method:$('method-'+i).value,
      confidence:Number($('confidence-'+i).value),note:$('note-'+i).value,confirmed:$('confirmed-'+i).checked});
    message(readable(result.decision)+(result.domain?' · '+result.domain:''));await loadAll();
  });
}

async function loadStatus(reviews=true) { view.state=await api('state');renderOperations();if(reviews)renderReviews(); }
function renderBatchSelection(){
  const batch=view.batches.find(b=>b.id===view.selectedBatch);
  $('batchDomains').value=batch?batch.words.map(w=>w.domain).join('\n'):'';
  $('batchStatus').textContent=batch?`${batch.state} · ${batch.words.length} retained lease${batch.words.length===1?'':'s'} · expires ${utc(batch.expires)}${batch.released_at?' · released '+utc(batch.released_at):''}. No registrar lookup performed.`:'No batch selected. Reserve a bounded batch or resume an active one.';
  $('resumeBatch').disabled=!batch;$('releaseBatch').disabled=!batch||batch.state!=='active';
  if(batch)sessionStorage.setItem('artha.selectedBatch',batch.id);
}
async function loadBatches(){
  view.batches=(await api('batches')).batches;
  if(!view.batches.some(b=>b.id===view.selectedBatch))view.selectedBatch=view.batches.find(b=>b.state==='active')?.id||view.batches[0]?.id||'';
  $('batchSelect').innerHTML=view.batches.length?view.batches.map(b=>`<option value="${escapeHtml(b.id)}">${escapeHtml(b.state)} · ${b.words.length} names · ${escapeHtml(utc(b.expires))}</option>`).join(''):'<option value="">No batches yet</option>';
  $('batchSelect').value=view.selectedBatch;renderBatchSelection();
  $('reserveBatch').textContent=sessionStorage.getItem('artha.pendingBatch')?'Retry reservation request':'Reserve next batch';
}
async function loadCandidates() {
  const version=++queryVersion;const params=new URLSearchParams({offset:String(view.offset)});
  for(const id of ['language','group','industry','persona','stage','evidence','availability','sort','suitability','commonness','friction'])params.set(id,$(id).value);
  params.set('q',$('search').value);if($('saved').checked)params.set('saved','1');
  const result=await api('candidates?'+params);if(version!==queryVersion)return;
  Object.assign(view,result);renderCards();
}
async function loadAll(reviews=true) { await loadStatus(reviews);await loadCandidates();await loadBatches(); }
async function act(button,operation) { button.disabled=true;try{await operation()}catch(error){message(error.message,true)}finally{button.disabled=false;if(['releaseBatch','resumeBatch'].includes(button.id))renderBatchSelection()} }
$('filters').onsubmit=event=>event.preventDefault();
for(const id of ['language','group','industry','persona','stage','evidence','availability','sort','suitability','commonness','friction','saved'])$(id).onchange=()=>{view.offset=0;loadCandidates().catch(e=>message(e.message,true))};
$('search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{view.offset=0;loadCandidates().catch(e=>message(e.message,true))},250)};
$('previous').onclick=()=>{view.offset=Math.max(0,view.offset-40);loadCandidates().catch(e=>message(e.message,true))};
$('next').onclick=()=>{view.offset=view.nextOffset;loadCandidates().catch(e=>message(e.message,true))};
$('reload').onclick=()=>act($('reload'),()=>loadAll());
$('toggleEngine').onclick=()=>act($('toggleEngine'),async()=>{await api('engine/control',{paused:!view.state.scheduler.paused});await loadStatus(false);message('Discovery control saved. Cron delivery must still be verified.')});
$('runEngine').onclick=()=>act($('runEngine'),async()=>{const result=await api('engine/run',{});message('Execution: '+readable(result.status));await loadAll()});
$('toggleProvider').onclick=()=>act($('toggleProvider'),async()=>{await api('provider',{enabled:!view.state.provider.enabled});await loadStatus(false);message('Provider control saved.')});
$('batchSelect').onchange=()=>{view.selectedBatch=$('batchSelect').value;renderBatchSelection()};
$('resumeBatch').onclick=()=>act($('resumeBatch'),async()=>{await loadBatches();message('Saved lease resumed in view. No new reservation or registrar request.')});
$('reserveBatch').onclick=()=>act($('reserveBatch'),async()=>{
  const count=Number($('batchCount').value);if(!Number.isInteger(count)||count<1||count>20)throw Error('Choose 1–20 names.');
  let pending;try{pending=JSON.parse(sessionStorage.getItem('artha.pendingBatch')||'null')}catch{}
  if(!pending){pending={request_id:crypto.randomUUID(),count};sessionStorage.setItem('artha.pendingBatch',JSON.stringify(pending));}
  const result=await api('next-batch',pending);sessionStorage.removeItem('artha.pendingBatch');view.selectedBatch=result.batch_id;
  await loadBatches();message(result.note);
});
$('releaseBatch').onclick=()=>act($('releaseBatch'),async()=>{await api('batches/release',{batch_id:view.selectedBatch});await loadBatches();message('Batch released. Later reservations can use these names if still due.')});
$('import').onclick=()=>act($('import'),async()=>{const result=await api('observations',{observations:JSON.parse($('importData').value)});$('importData').value='';message(result.count+' dated observations saved.');await loadAll(false)});
loadAll().catch(error=>message('Could not load persistent data: '+error.message,true));
setInterval(()=>{if(!document.hidden)loadStatus(false).catch(error=>message(error.message,true))},30_000);
