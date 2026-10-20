import {PipelineError, WIKTIONARY_LICENSE, cleanMeaning, plainDefinition, checkedFetch, boundedText, retryAfter, stableId} from './safety.js';

export const DICTIONARY_SOURCES = {
  nepali: {host: 'ne.wiktionary.org', language: 'Nepali', heading: 'नेपाली', start: 'ऀ', end: 'ॿ'},
  english: {host: 'en.wiktionary.org', language: 'English', heading: 'English', start: 'a', end: 'zzzzzzzzzz'}
};

function languageSection(text, heading) {
  const headings = [...String(text).matchAll(/^(={1,5})\s*([^=\n]+?)\s*\1\s*$/gm)];
  const position = headings.findIndex(x => x[2].trim() === heading && x[1].length <= 3);
  if (position < 0) return '';
  const start = headings[position];
  const end = headings.slice(position + 1).find(x => x[1].length <= start[1].length);
  return text.slice(start.index + start[0].length, end?.index ?? text.length);
}

function dictionaryLine(line) {
  // Only formatting templates with known semantics are removed. Unknown lexical templates fail closed.
  return plainDefinition(cleanMeaning(line)
    .replace(/\{\{(?:lb|label|context)\|(?:en|ne)\|[^{}]*\}\}/g, '')
    .replace(/\{\{(?:l|m)\|(?:en|ne)\|([^|{}]+)(?:\|([^|{}]+))?\}\}/g, (_, word, label) => label || word)
    .replace(/^[#*:]+\s*/, ''));
}

export function suggestedDefinition(text) {
  const section = languageSection(String(text), 'नेपाली');
  if (!section) return '';
  const marker = /^={2,5}\s*अर्थ\s*={2,5}\s*$/m.exec(section);
  if (!marker) return '';
  const meaning = section.slice(marker.index + marker[0].length).split(/^={1,5}[^=]/m)[0];
  return meaning.split('\n').map(x => x.trim()).filter(x => x && !/^[#*:]{2}/.test(x))
    .map(dictionaryLine).filter(Boolean).slice(0, 3).join('; ').slice(0, 1000);
}

export function englishDefinition(text) {
  const section = languageSection(String(text), 'English');
  return section.split('\n').filter(x => /^# [^:*#]/.test(x)).map(x => dictionaryLine(x.slice(2)))
    .find(Boolean) || '';
}
export function englishUsageLabels(text) {
  const section=languageSection(String(text),'English');
  const labels=new Set();
  for(const match of section.matchAll(/\{\{(?:lb|label|context)\|en\|([^{}]+)\}\}/g)) {
    for(const token of match[1].split('|').map(x=>x.trim().toLowerCase())) {
      if(['rare','uncommon','archaic','obsolete','dated','dialectal','nonstandard','technical','offensive','vulgar'].includes(token))labels.add(token);
    }
  }
  return [...labels];
}

export function dictionaryUrl(source, cursor = '',limit=10) {
  const config = DICTIONARY_SOURCES[source];
  if (!config || !Number.isInteger(limit)||limit<1||limit>10||typeof cursor !== 'string' || cursor.length > 200 || /[\u0000-\u001f]/.test(cursor)) {
    throw new PipelineError('invalid_dictionary_cursor', {retryable: false});
  }
  const url = new URL(`https://${config.host}/w/api.php`);
  url.search = new URLSearchParams({action: 'query', format: 'json', formatversion: '2', generator: 'allpages',
    gapnamespace: '0', gaplimit:String(limit), gapfilterredir: 'nonredirects', gapto: config.end,
    prop: 'revisions', rvprop: 'content|timestamp|ids', rvslots: 'main', maxlag: '5',
    ...(cursor ? {gapcontinue: cursor} : {gapfrom: config.start})}).toString();
  return url.href;
}

export async function readDictionary(source, cursor, {fetcher = fetch, now = Date.now(),limit=10,maxResponseBytes=750000,maxTextChars=50000} = {}) {
  const config = DICTIONARY_SOURCES[source];
  const url = dictionaryUrl(source, cursor,limit);
  const response = await checkedFetch(url, {headers: {'User-Agent': 'ArthaDomainLab/2.0 (+https://github.com/roshandhukdhuki/dh; bounded dictionary research)',
    'Accept': 'application/json'}}, fetcher, now);
  const delay = retryAfter(response.headers.get('retry-after'), now);
  let data;
  try { data = JSON.parse(await boundedText(response,maxResponseBytes)); }
  catch (error) { if (error instanceof PipelineError) throw error; throw new PipelineError('malformed_dictionary_response'); }
  if(!data||typeof data!=='object'||Array.isArray(data))throw new PipelineError('malformed_dictionary_response');
  if (data.error) {
    const lag = data.error.code === 'maxlag';
    const limited = ['ratelimited', 'readonly'].includes(data.error.code);
    throw new PipelineError(lag ? 'source_maxlag' : limited ? 'rate_limited' : 'dictionary_api_error',
      {retryable: lag || limited, retryAfterMs: delay});
  }
  const pages = data.query?.pages;
  if (!Array.isArray(pages) || pages.length > limit || pages.some(p => !p || typeof p.title !== 'string')) {
    // A successful, exhausted enumeration may omit query only when batchcomplete is explicit.
    if (!(data.batchcomplete === true && !data.query && !data.continue)) throw new PipelineError('malformed_dictionary_response');
  }
  const nextCursor = data.continue?.gapcontinue ?? '';
  if (typeof nextCursor !== 'string' || nextCursor.length > 200 || (nextCursor && nextCursor === cursor)) {
    throw new PipelineError('invalid_dictionary_cursor', {retryable: false});
  }
  const entries = [];
  let skipped = 0;
  for (const page of pages || []) {
    const revision = page.revisions?.[0];
    const text = revision?.slots?.main?.content;
    if (!Number.isSafeInteger(page.pageid) || page.pageid <= 0 || !Number.isSafeInteger(revision?.revid)
        || revision.revid <= 0 || !Number.isFinite(Date.parse(revision.timestamp)) || typeof text !== 'string'
        || text.length > maxTextChars || page.title.length > 100 || page.ns !== 0) { skipped++; continue; }
    const definition = source === 'nepali' ? suggestedDefinition(text) : englishDefinition(text);
    const spelling = source === 'english' ? /^[a-z]{4,10}$/.test(page.title) : /^[\u0900-\u097f]+$/.test(page.title);
    const eligible = !!definition && spelling;
    const entryUrl = `https://${config.host}/wiki/${encodeURIComponent(page.title)}`;
    entries.push({id: await stableId(source, page.pageid, revision.revid), source, page_id: page.pageid,
      revision_id: revision.revid, native: page.title, language: config.language, definition,
      raw_excerpt: text.slice(0, 5000), entry_url: entryUrl, revision_url: `${entryUrl}?oldid=${revision.revid}`,
      revision_at: new Date(revision.timestamp).toISOString(), retrieved_at: new Date(now).toISOString(),
      request_url: url, license: WIKTIONARY_LICENSE, eligible: +eligible,
      usage_labels:JSON.stringify(source==='english'?englishUsageLabels(text):[]),
      reason: eligible ? '' : !spelling ? 'spelling_out_of_scope' : 'no_plain_dictionary_definition'});
  }
  return {entries, nextCursor, exhausted: !nextCursor, skipped, requestUrl: url};
}
