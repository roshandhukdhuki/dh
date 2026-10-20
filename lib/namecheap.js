import {DOMAIN_PATTERN, PipelineError, checkedFetch, boundedText, safeHttpsUrl} from './safety.js';

export const NAMECHEAP_ENDPOINTS = Object.freeze({
  production: 'https://api.namecheap.com/xml.response',
  sandbox: 'https://api.sandbox.namecheap.com/xml.response'
});

export function providerStatus(env, enabled = false) {
  const mode = env.NAMECHEAP_ENVIRONMENT || 'production';
  const missing = ['NAMECHEAP_API_USER','NAMECHEAP_API_KEY','NAMECHEAP_CLIENT_IPV4'].filter(k => !env[k]);
  const ip = env.NAMECHEAP_CLIENT_IPV4 || '';
  const validIp = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').every(x => +x <= 255 && String(+x) === x);
  const blockers = [...missing.map(x => `Missing ${x}`)];
  for(const [key,max] of [['NAMECHEAP_API_USER',20],['NAMECHEAP_API_KEY',50]]) {
    if(env[key] && (typeof env[key]!=='string'||!env[key].trim()||env[key].length>max))blockers.push(`Invalid ${key} configuration`);
  }
  if (!NAMECHEAP_ENDPOINTS[mode]) blockers.push('Unsupported provider environment');
  if (env.NAMECHEAP_API_URL) blockers.push('Custom provider URLs are forbidden');
  if (ip && !validIp) blockers.push('Invalid client IPv4 configuration');
  if (env.NAMECHEAP_EGRESS_CONFIRMED !== 'true') blockers.push('Approved whitelisted static IPv4 egress has not been verified');
  if (env.NAMECHEAP_ACCESS_APPROVED !== 'true') blockers.push('Account eligibility, API terms and read-only use require approval');
  const configured = blockers.length === 0;
  return {provider: 'namecheap', mode, configured, enabled: !!enabled,
    ready: configured && !!enabled && mode === 'production',
    status: !configured ? 'not_configured' : mode === 'sandbox' ? 'sandbox_only' : enabled ? 'ready' : 'paused',
    blockers, maxDomainsPerJob: 5, minRequestIntervalMs: 240_000,
    credentials: 'Deployment secret bindings only. Never submit credentials through the dashboard.'};
}

function xmlAttrs(value) {
  const result = {};
  let rest = value.trim().replace(/\/$/, '').trim();
  while (rest) {
    const match = /^([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')\s*/.exec(rest);
    if (!match || Object.hasOwn(result, match[1])) throw new PipelineError('malformed_provider_response');
    result[match[1]] = match[2] ?? match[3];
    rest = rest.slice(match[0].length);
  }
  return result;
}

function numericAttribute(value) {
  return typeof value === 'string' && /^\d+(?:\.\d{1,8})?$/.test(value) && +value <= 1e9 ? +value : null;
}

export function parseNamecheap(xml, domains, now = Date.now(), mode = 'production') {
  if (typeof xml !== 'string' || xml.length > 200_000 || /<!|&(?:#|[a-z])/i.test(xml.replace(/&(?:amp|lt|gt|quot|apos);/g, ''))) {
    throw new PipelineError('malformed_provider_response');
  }
  const document=xml.replace(/^\s*(?:<\?xml[^?]*\?>\s*)?/,'');
  const root = /^<ApiResponse\b([^>]*)>([\s\S]*)<\/ApiResponse>\s*$/.exec(document);
  if (!root || /<\/?ApiResponse\b/.test(root[2])) throw new PipelineError('malformed_provider_response');
  const attrs = xmlAttrs(root[1]);
  if (attrs.Status === 'ERROR') {
    const code = /<Error\b[^>]*Number=["'](\d+)["']/.exec(xml)?.[1];
    const denied = ['1010101','1030408','1010102','1011102','1010105','1011105','1050900','1011150',
      '1017150','1017105','1017101','1017410','1017411','1019103','1016103','1017103'].includes(code);
    throw new PipelineError(denied ? 'provider_access_denied' : 'provider_api_error',
      {denied, retryable: !denied});
  }
  const command=/<CommandResponse\b([^>]*)>([\s\S]*?)<\/CommandResponse>/.exec(root[2]);
  if (attrs.Status !== 'OK' || !command || xmlAttrs(command[1]).Type!=='namecheap.domains.check') {
    throw new PipelineError('unexpected_provider_command');
  }
  const requested = new Set(domains);
  const byDomain = new Map();
  if(command[2].replace(/<DomainCheckResult\b[^>]*\/\s*>/g,'').trim())throw new PipelineError('malformed_provider_response');
  for (const match of command[2].matchAll(/<DomainCheckResult\b([^>]*?)\s*\/\s*>/g)) {
    const row = xmlAttrs(match[1]);
    if (!requested.has(row.Domain)) throw new PipelineError('unexpected_provider_domain');
    if (byDomain.has(row.Domain)) { byDomain.set(row.Domain, null); continue; }
    byDomain.set(row.Domain, row);
  }
  return domains.map(domain => {
    const row = byDomain.get(domain);
    let status = 'transient_error', error_code = 'missing_provider_result';
    if (row) {
      if (row.ErrorNo !== '0') error_code = 'provider_domain_error';
      else if (!['true','false'].includes(row.Available) || !['true','false'].includes(row.IsPremiumName)) error_code = 'malformed_provider_result';
      else { status = row.Available === 'false' ? 'unavailable' : row.IsPremiumName === 'true' ? 'premium' : 'standard_offer'; error_code = ''; }
    }
    return {domain, status, error_code, checked_at: new Date(now).toISOString(),
      source_url: NAMECHEAP_ENDPOINTS[mode], provider: 'namecheap', environment: mode, kind: 'official_api',
      evidence: error_code ? 'Official API did not supply a usable result for this domain.' :
        `Official namecheap.domains.check response: Available=${row.Available}; IsPremiumName=${row.IsPremiumName}. Checkout, taxes and final availability unconfirmed.`,
      price: status === 'premium' ? numericAttribute(row.PremiumRegistrationPrice) : null,
      renewal_price: status === 'premium' ? numericAttribute(row.PremiumRenewalPrice) : null,
      // domains.check does not supply currency, term, or regular registration price. Never invent them.
      currency: null, period_months: null};
  });
}

export async function checkNamecheap(domains, env, {fetcher = fetch, now = Date.now()} = {}) {
  const status = providerStatus(env, true);
  if (!status.configured) throw new PipelineError('provider_not_configured', {retryable: false});
  if (!Array.isArray(domains) || !domains.length || domains.length > 50 || new Set(domains).size !== domains.length
      || domains.some(x => !DOMAIN_PATTERN.test(x))) throw new PipelineError('invalid_provider_domains', {retryable: false});
  const url = new URL(NAMECHEAP_ENDPOINTS[status.mode]);
  // Endpoints are selected from a closed enum. Redirects cannot move the credential-bearing request.
  if (!safeHttpsUrl(url.href, ['api.namecheap.com','api.sandbox.namecheap.com'], p => p === '/xml.response')) {
    throw new PipelineError('invalid_provider_url', {retryable: false});
  }
  url.search = new URLSearchParams({ApiUser: env.NAMECHEAP_API_USER, ApiKey: env.NAMECHEAP_API_KEY,
    UserName: env.NAMECHEAP_API_USER, ClientIp: env.NAMECHEAP_CLIENT_IPV4,
    Command: 'namecheap.domains.check', DomainList: domains.join(',')}).toString();
  const response = await checkedFetch(url.href, {headers: {Accept: 'application/xml'}}, fetcher, now);
  const xml = await boundedText(response, 200_000);
  return parseNamecheap(xml, domains, now, status.mode);
}
