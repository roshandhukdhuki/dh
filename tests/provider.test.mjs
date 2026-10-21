import test from 'node:test';
import assert from 'node:assert/strict';
import {checkNamecheap,parseNamecheap,providerStatus} from '../lib/namecheap.js';
import {TEST_NOW,TEST_PROVIDER,providerXml,providerRow} from './helpers.mjs';

test('official adapter has an explicit unconfigured state and sends no request without approved access',async()=>{
  let calls=0;assert.equal(providerStatus({}).status,'not_configured');
  await assert.rejects(checkNamecheap(['tree.com'],{}, {fetcher:async()=>{calls++}}),error=>error.code==='provider_not_configured');assert.equal(calls,0);
  assert.equal(providerStatus(TEST_PROVIDER).status,'paused');assert.equal(providerStatus(TEST_PROVIDER,true).ready,true);
});
test('provider uses the official read-only command and a fixed HTTPS endpoint',async()=>{
  let captured;
  const observations=await checkNamecheap(['tree.com'],TEST_PROVIDER,{now:TEST_NOW,fetcher:async(url,options)=>{captured={url:new URL(url),options};return new Response(providerXml(providerRow('tree.com')))}});
  assert.equal(captured.url.origin,'https://api.namecheap.com');assert.equal(captured.url.searchParams.get('Command'),'namecheap.domains.check');
  assert.equal(captured.options.redirect,'error');assert.equal(observations[0].status,'standard_offer');assert.equal(observations[0].price,null);assert.equal(observations[0].currency,null);assert.equal(observations[0].period_months,null);
  assert(!JSON.stringify(observations).includes(TEST_PROVIDER.NAMECHEAP_API_KEY));assert.equal(observations[0].source_url,'https://api.namecheap.com/xml.response');
});
test('fixed endpoint configuration rejects SSRF, redirects and unsupported environments',async()=>{
  for(const override of [{NAMECHEAP_ENVIRONMENT:'https://127.0.0.1/'},{NAMECHEAP_API_URL:'https://evil.test/'},{NAMECHEAP_CLIENT_IPV4:'999.0.0.1'},{NAMECHEAP_EGRESS_CONFIRMED:'false'}]) {
    assert.equal(providerStatus({...TEST_PROVIDER,...override},true).configured,false);
  }
  await assert.rejects(checkNamecheap(['tree.com'],TEST_PROVIDER,{fetcher:async()=>{throw Error('redirect to internal address')}}),error=>error.code==='network_error'&&!error.message.includes('internal address'));
});
test('sandbox responses are explicitly isolated from production readiness',async()=>{
  const env={...TEST_PROVIDER,NAMECHEAP_ENVIRONMENT:'sandbox'};
  assert.equal(providerStatus(env,true).status,'sandbox_only');assert.equal(providerStatus(env,true).ready,false);
  const rows=await checkNamecheap(['tree.com'],env,{now:TEST_NOW,fetcher:async()=>new Response(providerXml(providerRow('tree.com')))});
  assert.equal(rows[0].environment,'sandbox');assert(rows[0].source_url.includes('sandbox'));
});
test('premium amounts retain only supplied values without inventing currency or renewal certainty',()=>{
  const xml=providerXml('<DomainCheckResult Domain="tree.com" Available="true" IsPremiumName="true" ErrorNo="0" PremiumRegistrationPrice="13000.0000" PremiumRenewalPrice="500.0000"/>');
  const row=parseNamecheap(xml,['tree.com'],TEST_NOW)[0];assert.equal(row.status,'premium');assert.equal(row.price,13000);assert.equal(row.renewal_price,500);assert.equal(row.currency,null);assert.equal(row.period_months,null);
});
test('unavailability is not falsely labeled registration, and missing results stay transient errors',()=>{
  const xml=providerXml('<DomainCheckResult Domain="tree.com" Available="false" IsPremiumName="false" ErrorNo="0"/>');
  const rows=parseNamecheap(xml,['tree.com','wood.com'],TEST_NOW);assert.equal(rows[0].status,'unavailable');assert.equal(rows[1].status,'transient_error');
});
test('provider authentication failures stop retries and never leak upstream text',()=>{
  const xml='<ApiResponse Status="ERROR"><Errors><Error Number="1016103">ApiKey='+TEST_PROVIDER.NAMECHEAP_API_KEY+'</Error></Errors></ApiResponse>';
  assert.throws(()=>parseNamecheap(xml,['tree.com']),error=>error.denied&&error.code==='provider_access_denied'&&!error.message.includes(TEST_PROVIDER.NAMECHEAP_API_KEY));
});
test('malformed XML, entities, foreign domains, duplicate results and wrong commands cannot become offers',()=>{
  for(const xml of ['<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///private">]><ApiResponse/>','<ApiResponse Status="OK">broken',
    providerXml(providerRow('evil.com')),providerXml(providerRow('tree.com')).replace('namecheap.domains.check','namecheap.domains.create'),
    '<ApiResponse Status="OK"><CommandResponse Type="namecheap.domains.check">'+providerRow('tree.com')+'</ApiResponse>'])assert.throws(()=>parseNamecheap(xml,['tree.com']));
  assert.equal(parseNamecheap(providerXml(providerRow('tree.com')+providerRow('tree.com')),['tree.com'])[0].status,'transient_error');
});
test('provider batches enforce official size, deduplication and ASCII scope before network access',async()=>{
  for(const domains of [[],['tree.com','tree.com'],['a1bc.com'],Array(51).fill('tree.com')])await assert.rejects(checkNamecheap(domains,TEST_PROVIDER),error=>error.code==='invalid_provider_domains');
});
