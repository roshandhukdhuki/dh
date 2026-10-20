import {PipelineError,STALE_MS} from './safety.js';
import {FIT_RULES,qualityFor} from './quality.js';

function searchLiteral(value) { return value.replace(/[\\%_]/g, '\\$&'); }

export async function candidates(store, params, now) {
  const term = (params.get('q') || '').trim();
  const language = params.get('language') || 'all', group = params.get('group') || 'all';
  const stage = params.get('stage') || 'all', sort = params.get('sort') || 'brand';
  const status = params.get('availability') || 'all', evidence = params.get('evidence') || 'all';
  const industry = params.get('industry') || 'all', persona = params.get('persona') || 'all';
  const suitability=params.get('suitability')||'all',commonness=params.get('commonness')||'all',friction=params.get('friction')||'all';
  const offset = Number(params.get('offset') || 0), limit = 40;
  if(new TextEncoder().encode(searchLiteral(term)).length>48)throw new PipelineError('search_term_exceeds_48_utf8_bytes',{retryable:false});
  if (term.length > 100 || !['all','Nepali','English'].includes(language) || !['all','4','5','6-10'].includes(group)
      || !['all','new','shortlist','watchlist','rejected'].includes(stage) || !['all','verified','history'].includes(evidence)
      || !['all','unknown','standard_offer','registered','unavailable','premium','transient_error','stale'].includes(status)
      || (industry !== 'all' && FIT_RULES[industry]?.type !== 'industry') || (persona !== 'all' && FIT_RULES[persona]?.type !== 'persona')
      || !['all','promising_signals','needs_review','high_friction','unassessed'].includes(suitability)
      || !['all','unknown','source_flagged_rare','source_flagged_dated','source_flagged_specialist'].includes(commonness)
      || !['all','low','moderate','high','unknown'].includes(friction)
      || !Number.isInteger(offset) || offset < 0 || offset > 1_000_000) throw new PipelineError('invalid_filters',{retryable:false});
  const clauses = ['1']; const args = [];
  if (term) { clauses.push(`(w.word LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM meanings m WHERE m.domain=w.domain AND (m.native LIKE ? ESCAPE '\\' OR (m.definition||' '||m.reviewed_definition) LIKE ? ESCAPE '\\')))`);
    const q = '%' + searchLiteral(term) + '%'; args.push(q,q,q); }
  if (language !== 'all') { clauses.push('EXISTS(SELECT 1 FROM meanings m WHERE m.domain=w.domain AND m.language=?)'); args.push(language); }
  if (group !== 'all') { clauses.push(group === '6-10' ? 'length(w.word) BETWEEN 6 AND 10' : 'length(w.word)=?'); if (group !== '6-10') args.push(+group); }
  if (stage !== 'all') { clauses.push('w.triage=?'); args.push(stage); }
  if (params.get('saved') === '1') clauses.push('w.favorite=1');
  if (evidence !== 'all') clauses.push(`${evidence === 'history' ? 'NOT ' : ''}EXISTS(SELECT 1 FROM meanings m WHERE m.domain=w.domain AND m.accepted=1)`);
  for(const [column,value] of [['brand_suitability',suitability],['commonness_status',commonness],['spelling_friction',friction]]) {
    if(value!=='all'){clauses.push(`EXISTS(SELECT 1 FROM meanings m WHERE m.domain=w.domain AND m.${column}=?)`);args.push(value);}
  }
  for (const tag of [industry,persona].filter(t => t !== 'all')) {
    const tokenClauses=[];
    for(const token of FIT_RULES[tag].tokens) {
      if(/^[a-z]+$/.test(token)) {
        tokenClauses.push("((' '||lower(m.definition||' '||m.reviewed_definition)||' ') GLOB ? OR (' '||lower(m.definition||' '||m.reviewed_definition)||' ') GLOB ?)");
        args.push(`*[^a-z]${token}[^a-z]*`,`*[^a-z]${token}s[^a-z]*`);
      } else {tokenClauses.push("(m.definition||' '||m.reviewed_definition) LIKE ? ESCAPE '\\'");args.push('%'+searchLiteral(token)+'%');}
    }
    clauses.push(`EXISTS(SELECT 1 FROM meanings m WHERE m.domain=w.domain AND (${tokenClauses.join(' OR ')}))`);
  }
  if (status === 'unknown') clauses.push("(o.domain IS NULL OR o.status='unknown')");
  else if (status === 'stale') { clauses.push('o.checked_at<?'); args.push(new Date(now - STALE_MS).toISOString()); }
  else if (status === 'standard_offer') clauses.push("o.status IN ('available','standard_offer')");
  else if (status === 'transient_error') clauses.push("(SELECT status FROM availability_events e WHERE e.domain=w.domain ORDER BY checked_at DESC,id DESC LIMIT 1)='transient_error'");
  else if (status !== 'all') { clauses.push('o.status=?'); args.push(status); }
  const scoreSql = `COALESCE((SELECT MAX(m.brand_score) FROM meanings m WHERE m.domain=w.domain AND m.accepted=1),0)`;
  const nepaliFirst="CASE WHEN EXISTS(SELECT 1 FROM meanings m WHERE m.domain=w.domain AND m.language='Nepali' AND m.accepted=1) THEN 0 ELSE 1 END";
  const sorting = {brand:`${nepaliFirst},${scoreSql} DESC,w.favorite DESC,length(w.word),w.word`,nepali:nepaliFirst+",w.favorite DESC,w.word",
    score:scoreSql+' DESC,w.word',name:'w.word',length:'length(w.word),w.word',newest:'w.fetched DESC,w.word',checked:'o.checked_at DESC,w.word'}[sort];
  if (!sorting) throw new PipelineError('invalid_sort',{retryable:false});
  const from = `FROM words w LEFT JOIN observations o ON o.domain=w.domain WHERE ${clauses.join(' AND ')}`;
  const count = await store.stmt('SELECT COUNT(*) AS n ' + from, ...args).first();
  const words = await store.all(`SELECT w.* ${from} ORDER BY ${sorting} LIMIT ? OFFSET ?`, ...args,limit,offset);
  // Batch related rows instead of making a separate query for every rendered card.
  const names = words.map(w => w.domain), marks = names.map(() => '?').join(',');
  const meanings = names.length ? await store.all(`SELECT * FROM meanings WHERE domain IN (${marks}) ORDER BY accepted DESC,language,native`,...names) : [];
  const observations = names.length ? await store.all(`SELECT * FROM observations WHERE domain IN (${marks})`,...names) : [];
  const attempts = names.length ? await store.all(`SELECT * FROM (SELECT *,ROW_NUMBER() OVER(PARTITION BY domain ORDER BY checked_at DESC,id DESC) AS rn
    FROM availability_events WHERE domain IN (${marks})) WHERE rn=1`,...names) : [];
  const successes = names.length ? await store.all(`SELECT domain,MAX(checked_at) AS checked_at FROM availability_events
    WHERE domain IN (${marks}) AND status NOT IN ('transient_error','unknown') GROUP BY domain`,...names) : [];
  for (const word of words) {
    word.meanings = meanings.filter(m => m.domain === word.domain);
    word.observation = observations.find(o => o.domain === word.domain) || null;
    word.last_attempt = attempts.find(o => o.domain === word.domain) || null;
    word.last_successful_check = successes.find(o => o.domain === word.domain)?.checked_at || null;
    const accepted = word.meanings.filter(m => m.accepted === 1);
    word.evidence_status = accepted.length ? 'dictionary_definition_verified' : 'historical_research';
    word.quality = qualityFor(word.word,accepted.length ? accepted : word.meanings);
    word.stale = !!word.observation && now - Date.parse(word.observation.checked_at) > STALE_MS;
  }
  return {words,total:count.n,offset,limit,nextOffset:offset + words.length < count.n ? offset + words.length : null};
}
