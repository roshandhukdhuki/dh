import {LocalD1,migrateLocal} from '../scripts/sqlite.mjs';
import {LabStore} from '../lib/store.js';

export const TEST_NOW = Date.parse('2026-10-20T12:00:00Z');
export function testEnv(options = {}) { const DB=new LocalD1();migrateLocal(DB);
  return {DB,ACCESS_MODE:'platform',PRIVATE_DEPLOYMENT_CONFIRMED:'true',SCHEDULER_ENABLED:'true',...options}; }
export async function readyEnv(options = {}) { const env=testEnv(options);await new LabStore(env.DB).setPaused(false,TEST_NOW);return env; }
export const TEST_PROVIDER = {NAMECHEAP_API_USER:'unit_test_fixture',NAMECHEAP_API_KEY:'TEST_ONLY_NOT_A_CREDENTIAL',
  NAMECHEAP_CLIENT_IPV4:'192.0.2.10',NAMECHEAP_ACCESS_APPROVED:'true',NAMECHEAP_EGRESS_CONFIRMED:'true'};
export function wikiPage(title,content,id=1) { return {pageid:id,ns:0,title,revisions:[{revid:id+1000,timestamp:'2026-10-19T00:00:00Z',slots:{main:{content}}}]}; }
export function wikiJson(pages,next = '') { return new Response(JSON.stringify({batchcomplete:true,query:{pages},...(next?{continue:{gapcontinue:next,continue:'gapcontinue||'}}:{})}),{headers:{'Content-Type':'application/json'}}); }
export function fixtureSources({nepali = [wikiPage('अर्ना','==नेपाली==\n===अर्थ===\n# जङ्गली भाले भैँसी',1)],
  english = [wikiPage('tree','==English==\n===Noun===\n# A woody plant with a trunk.',2)],next=''} = {}) {
  const calls=[];
  const fetcher=async(url,options)=>{calls.push({url,options});return wikiJson(new URL(url).hostname==='ne.wiktionary.org'?nepali:english,next)};
  return {fetcher,calls};
}
export function apiRequest(path,body,headers={}) { return new Request('https://app.example.test/api/'+path,
  body===undefined?{headers}:{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://app.example.test',...headers},body:JSON.stringify(body)}); }
export async function word(store,domain='tree.com',language='English') { await store.stmt(`INSERT OR IGNORE INTO words(domain,word,meaning,language,source,fetched)
  VALUES(?,?,?,?,?,?)`,domain,domain.slice(0,-4),'Synthetic test dictionary definition',language,'https://en.wiktionary.org/wiki/'+domain.slice(0,-4),new Date(TEST_NOW).toISOString()).run(); }
export function providerXml(rows) { return `<ApiResponse Status="OK"><CommandResponse Type="namecheap.domains.check">${rows}</CommandResponse></ApiResponse>`; }
export function providerRow(domain,extra='') { return `<DomainCheckResult Domain="${domain}" Available="true" ErrorNo="0" IsPremiumName="false" ${extra}/>`; }
