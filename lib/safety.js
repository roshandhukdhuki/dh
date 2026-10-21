export const DOMAIN_PATTERN = /^[a-z]{4,10}\.com$/;
export const WIKTIONARY_LICENSE = 'CC-BY-SA-4.0; Wikimedia Terms of Use and entry-specific exceptions apply';
export const CADENCE_MS = 4 * 60_000;
export const LEASE_MS = 90_000;
export const RUN_BUDGET_MS = 25_000;
export const STALE_MS = 6 * 3_600_000;

export class PipelineError extends Error {
  constructor(code, {retryable = true, retryAfterMs = 0, denied = false} = {}) {
    super(code);
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.denied = denied;
  }
}

export function safeError(error) {
  // Never serialize upstream messages, fetch exceptions, response bodies or credential-bearing URLs.
  return error instanceof PipelineError ? error : new PipelineError('internal_error');
}

export function cleanMeaning(value) {
  return String(value ?? '').replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1').trim();
}

export function plainDefinition(value) {
  if (typeof value !== 'string' || value.length > 50_000) return '';
  const clean = cleanMeaning(value).replace(/'{2,}/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length < 3 || !/\p{L}/u.test(clean) || /[<>{}\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(clean)
      || /\[\[|\]\]|(?:javascript|data|vbscript):|https?:\/\//i.test(clean)) return '';
  return clean.slice(0, 1000);
}

export function normalize(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter(x => x && /^[a-z]{4,10}$/.test(x.word) && Array.isArray(x.defs))
    .map(x => ({domain: x.word + '.com', word: x.word,
      meaning: x.defs.filter(d => typeof d === 'string').map(d => plainDefinition(d.replace(/^[a-z]+\t/, '')))
        .filter(Boolean).join('; ').slice(0, 1000)})).filter(x => x.meaning);
}

export function safeHttpsUrl(value, hosts, path) {
  try {
    if (typeof value !== 'string' || value.length > 1800) return null;
    const url = new URL(value);
    if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.username || url.password || url.port
        || url.hash || (path && !path(url.pathname))) return null;
    if ([...url.searchParams.keys()].some(k => /key|token|secret|password|auth|signature/i.test(k))) return null;
    return url;
  } catch { return null; }
}

export function validReview(body) {
  return body && typeof body.word === 'string' && body.word.length > 0 && body.word.length <= 100
    && ['approve', 'reject'].includes(body.action) && typeof body.note === 'string' && body.note.length <= 500
    && (body.action === 'reject' || (/^[a-z]{4,10}$/.test(body.romanization) && !!plainDefinition(body.meaning)
      && body.meaning.length <= 1000 && body.confirmed === true));
}

export function retryDelay(attempt, retryAfterMs = 0, random = Math.random) {
  return Math.max(retryAfterMs, Math.min(24 * 3_600_000, CADENCE_MS * 2 ** Math.max(0, attempt - 1))
    + Math.floor(random() * 30_000));
}

export function retryAfter(value, now) {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  return Math.max(0, Date.parse(value) - now) || 0;
}

export async function stableId(...parts) {
  const bytes = new TextEncoder().encode(JSON.stringify(parts));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('');
}

export async function boundedText(response, limit = 750_000) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new PipelineError('response_too_large', {retryable: false});
  }
  if (!response.body) throw new PipelineError('empty_response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new PipelineError('response_too_large', {retryable: false});
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder('utf-8', {fatal: true}).decode(output);
}

export async function checkedFetch(url, options, fetcher, now) {
  let response;
  try {
    response = await fetcher(url, {...options, redirect: 'error', signal: AbortSignal.timeout(8000)});
  } catch { throw new PipelineError('network_error'); }
  if ([401, 403].includes(response.status)) {
    await response.body?.cancel();
    throw new PipelineError('access_denied', {retryable: false, denied: true});
  }
  if (!response.ok) {
    const delay = retryAfter(response.headers.get('retry-after'), now);
    await response.body?.cancel();
    throw new PipelineError(response.status === 429 ? 'rate_limited' : 'upstream_http_error',
      {retryable: response.status === 429 || response.status >= 500, retryAfterMs: delay});
  }
  return response;
}

export function validateImport(rows, now = Date.now()) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 100) throw new PipelineError('invalid_import', {retryable: false});
  const allowed = new Set(['domain','status','checked_at','source_url','evidence','price','currency','period_months']);
  const seen = new Set();
  return rows.map(row => {
    if (!row || Object.keys(row).some(k => !allowed.has(k))) throw new PipelineError('invalid_import', {retryable: false});
    const url = safeHttpsUrl(row.source_url, ['namecheap.com', 'www.namecheap.com']);
    const time = validIsoTimestamp(row.checked_at) ? Date.parse(row.checked_at) : NaN;
    if (!DOMAIN_PATTERN.test(row.domain) || !['available','standard_offer','registered','unavailable','premium','unknown','transient_error'].includes(row.status)
        || !url || !Number.isFinite(time) || time < 0 || time > now + 60_000
        || typeof row.evidence !== 'string' || !row.evidence.trim() || row.evidence.length > 2000
        || /[<>\u0000-\u0008]/.test(row.evidence) || /(?:apikey|password|bearer|secret)\s*[:=]/i.test(row.evidence)
        || seen.has(row.domain)) throw new PipelineError('invalid_import', {retryable: false});
    seen.add(row.domain);
    if (row.price != null && (!Number.isFinite(row.price) || row.price < 0 || row.price > 1e9)) throw new PipelineError('invalid_price', {retryable: false});
    if (row.currency != null && !/^[A-Z]{3}$/.test(row.currency)) throw new PipelineError('invalid_currency', {retryable: false});
    if (row.period_months != null && (!Number.isInteger(row.period_months) || row.period_months < 1 || row.period_months > 120)) throw new PipelineError('invalid_period', {retryable: false});
    return {...row, checked_at: new Date(time).toISOString(), source_url: url.href, provider: 'namecheap', environment: 'production',
      kind: 'manual', price: row.price ?? null, currency: row.currency ?? null, period_months: row.period_months ?? null,
      renewal_price: null, error_code: row.status === 'transient_error' ? 'manual_transient_error' : ''};
  });
}

export function validIsoTimestamp(value) {
  if(typeof value!=='string')return false;
  const parts=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if(!parts||!Number.isFinite(Date.parse(value)))return false;
  const [year,month,day,hour,minute,second]=parts.slice(1,7).map(Number);
  const date=new Date(Date.UTC(year,month-1,day));
  return year>=1970&&date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day
    && hour<24&&minute<60&&second<60;
}
