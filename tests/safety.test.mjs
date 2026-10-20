import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {cleanMeaning,normalize,validReview,plainDefinition,validateImport,safeHttpsUrl,retryDelay,boundedText} from '../lib/safety.js';
import {englishDefinition,suggestedDefinition,readDictionary,dictionaryUrl} from '../lib/dictionary.js';
import {proposeRomanization} from '../lib/romanization.js';
import {TEST_NOW,wikiPage,wikiJson} from './helpers.mjs';

test('original meaning, ASCII, length, wiki-markup and blank-definition regressions',()=>{
  assert.deepEqual(normalize([{word:'tree',defs:['n\ta woody plant']}]),[{domain:'tree.com',word:'tree',meaning:'a woody plant'}]);
  assert.equal(normalize([{word:'fake'},{word:'foo',defs:['short']},{word:'abc123',defs:['bad']},{word:'abcdefghijk',defs:['long']},{word:'test',defs:['n\t  ']}]).length,0);
  assert.equal(cleanMeaning('To [[separate]] or [[reduce|shrink]]'),'To separate or shrink');
  assert.equal(normalize(null).length,0);
});
test('existing public seed stays historical and retains source evidence',()=>{
  const seed=JSON.parse(fs.readFileSync('seed.json'));assert.equal(seed.length,54);
  assert(seed.every(x=>x.meaning_verified===1&&x.meaning&&/^[a-z]{4,10}\.com$/.test(x.domain)&&x.source));
});
test('review validation rejects blank, malformed or unconfirmed approval',()=>{
  const approval={word:'चिर',action:'approve',note:'Checked source',romanization:'chir',meaning:'long time',confirmed:true};
  assert(validReview(approval));for(const changes of [{romanization:'chi'},{romanization:'a1bc'},{confirmed:false},{meaning:'  '},{meaning:'<script>bad</script>'}])assert(!validReview({...approval,...changes}));
  assert(validReview({word:'चिर',action:'reject',note:'Not suitable'}));assert(!validReview(null));
});
test('definition extraction requires an explicit matching language section',()=>{
  assert.equal(suggestedDefinition('==नेपाली==\n===अर्थ===\n# लामो समय\n===अन्य==='),'लामो समय');
  assert.equal(suggestedDefinition('==हिन्दी==\n===अर्थ===\n# test'),'');
  assert.equal(englishDefinition('==French==\n# A French meaning.\n==English==\n===Noun===\n# A [[woody|wooden]] object.\n==Latin==\n# A Latin meaning.'),'A wooden object.');
});
test('injected, malformed and template-only content cannot become verified meanings',()=>{
  for(const value of ['<script>fetch(secret)</script>','{{invented|meaning}}','javascript:evil','\u0000bad','https://example.test','   '])assert.equal(plainDefinition(value),'');
  assert.equal(englishDefinition('==English==\n# {{unknown|en|wood}}'),'');
  assert.equal(englishDefinition('==English==\n# A [[broken reference.'),'');
  assert.equal(englishDefinition('==English==\n# {{lb|en|botany}} A woody plant.'),'A woody plant.');
  assert.equal(suggestedDefinition('==नेपाली==\n===अर्थ===\n# <img src=x onerror=evil()>'),'');
});
test('romanization preserves uncertainty and never calls practical spelling standardized',()=>{
  const arna=proposeRomanization('अर्ना');assert.equal(arna.suggestion,'arna');assert(arna.confidence>=0.9);assert.equal(arna.issues.length,0);
  const ambak=proposeRomanization('अम्बक');assert.equal(ambak.suggestion,'ambak');assert(ambak.confidence<0.9);
  const vakalat=proposeRomanization('वकालत');assert.equal(vakalat.suggestion,'vakalat');assert(vakalat.issues.some(x=>x.includes('v/w')));
  assert(arna.explanation.includes('Not source-attested or standardized'));assert.equal(proposeRomanization('not Nepali').confidence,0);
});
test('dictionary adapter uses bounded sequential enumeration and exact revision attribution',async()=>{
  let called;
  const data=await readDictionary('english','tree',{now:TEST_NOW,fetcher:async(url,options)=>{called={url:new URL(url),options};return wikiJson([wikiPage('tree','==English==\n# A woody plant.',2)],'trench')}});
  assert.equal(called.url.searchParams.get('gaplimit'),'10');assert.equal(called.url.searchParams.get('maxlag'),'5');assert.equal(called.url.searchParams.get('gapcontinue'),'tree');assert.equal(called.options.redirect,'error');
  assert.equal(data.entries[0].revision_url,'https://en.wiktionary.org/wiki/tree?oldid=1002');assert.equal(data.entries[0].retrieved_at,new Date(TEST_NOW).toISOString());assert(data.entries[0].license.includes('CC-BY-SA'));assert.equal(data.nextCursor,'trench');
  assert.throws(()=>dictionaryUrl('sanskrit'));assert.throws(()=>dictionaryUrl('english','x'.repeat(201)));
});
test('dictionary partial batches retain good entries and skip malformed revisions',async()=>{
  const bad=wikiPage('fake','==English==\n# A possible thing.',3);bad.revisions[0].revid='not-an-id';
  const result=await readDictionary('english','',{now:TEST_NOW,fetcher:async()=>wikiJson([bad,wikiPage('tree','==English==\n# A woody plant.',2)])});
  assert.equal(result.entries.length,1);assert.equal(result.skipped,1);
});
test('source maxlag, denial, rate limits and malformed bodies remain truthful',async()=>{
  for(const [response,code] of [[new Response(JSON.stringify({error:{code:'maxlag'}}),{headers:{'Retry-After':'600'}}),'source_maxlag'],[new Response('',{status:403}),'access_denied'],[new Response('',{status:429,headers:{'Retry-After':'600'}}),'rate_limited'],[new Response('{broken'),'malformed_dictionary_response']]) {
    await assert.rejects(readDictionary('english','',{now:TEST_NOW,fetcher:async()=>response}),error=>error.code===code);
  }
});
test('SSRF and secret-bearing source URLs are rejected',()=>{
  const hosts=['www.namecheap.com'];
  for(const url of ['http://www.namecheap.com/','https://www.namecheap.com.evil.test/','https://user:pw@www.namecheap.com/','https://127.0.0.1/','https://[::1]/','https://www.namecheap.com:444/','https://www.namecheap.com/?ApiKey=hidden'])assert.equal(safeHttpsUrl(url,hosts),null);
  assert(safeHttpsUrl('https://www.namecheap.com/domains/',hosts));
});
test('manual observation import validates price, period, UTC, evidence and domain scope',()=>{
  const row={domain:'tree.com',status:'standard_offer',checked_at:new Date(TEST_NOW).toISOString(),source_url:'https://www.namecheap.com/domains/',evidence:'Visible registrar offer for one year',price:12.3,currency:'USD',period_months:12};
  assert.equal(validateImport([row],TEST_NOW)[0].price,12.3);
  for(const changes of [{domain:'a1bc.com'},{status:'buyable'},{checked_at:'2026-10-20 12:00:00'},{checked_at:'2026-02-30T12:00:00Z'},{checked_at:'2030-01-01T00:00:00Z'},{evidence:'  '},{price:-1},{price:'12.3'},{currency:'usd'},{period_months:0},{ApiKey:'secret'},{source_url:'https://evil.test/'}])assert.throws(()=>validateImport([{...row,...changes}],TEST_NOW));
  assert.throws(()=>validateImport([row,row],TEST_NOW));assert.throws(()=>validateImport([],TEST_NOW));
});
test('retry backoff respects provider Retry-After and caps exponential growth',()=>{
  assert.equal(retryDelay(1,0,()=>0),240000);assert.equal(retryDelay(2,0,()=>0),480000);
  assert.equal(retryDelay(1,3600000,()=>0),3600000);assert.equal(retryDelay(20,0,()=>0),86400000);
});
test('streaming limits apply even without a content-length header',async()=>{
  await assert.rejects(boundedText(new Response('x'.repeat(200)),100),error=>error.code==='response_too_large');
});
