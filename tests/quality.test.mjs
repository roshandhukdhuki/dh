import test from 'node:test';
import assert from 'node:assert/strict';
import {brandSignals,qualityFor} from '../lib/quality.js';
import {englishUsageLabels} from '../lib/dictionary.js';
import {runTick} from '../lib/engine.js';
import {LabStore} from '../lib/store.js';
import {candidates} from '../lib/candidates.js';
import {TEST_NOW,readyEnv,fixtureSources,wikiPage} from './helpers.mjs';

test('brand suitability is separate from dictionary validity and favors short usable spellings',()=>{
  const short=brandSignals('tree',{language:'English'}),obscure=brandSignals('systylious',{language:'English',usage_labels:'["rare"]'});
  assert(short.score>obscure.score);assert.equal(short.suitability,'promising_signals');assert.equal(obscure.suitability,'high_friction');
  assert.equal(short.commonness,'unknown');assert.equal(obscure.commonness,'source_flagged_rare');assert.equal(short.pronunciationConfidence,'heuristic_only');
  assert(brandSignals('unbibulous',{usage_labels:'[]'}).score<55);assert(obscure.reasons.some(r=>r.includes('−25')));
});
test('usage labels come only from an explicit English language section and are conservative sense warnings',()=>{
  assert.deepEqual(englishUsageLabels('==French==\n# {{lb|en|rare}} A French sense.\n==English==\n# {{lb|en|obsolete|technical}} A definition.'),['obsolete','technical']);
  assert.deepEqual(englishUsageLabels('==English==\n# {{unknown|common}} A definition.'),[]);
});
test('fit explanations use whole English words so plant does not imply a consultant plan',()=>{
  const tree=qualityFor('tree',[{definition:'A woody plant.',language:'English',accepted:1}]);assert(!tree.tags.some(t=>t.tag==='Consultant'));
  const guide=qualityFor('guide',[{definition:'A person who offers advice and plans.',language:'English',accepted:1}]);
  assert(guide.tags.some(t=>t.tag==='Consultant'&&t.explanation.includes('advice')));assert(guide.caveat.includes('No monetary valuation'));
});
test('ranking and filters retain low-scoring valid words without automatically shortlisting them',async()=>{
  const env=await readyEnv();const english=[wikiPage('systylious','==English==\n# {{lb|en|rare}} A synthetic rare technical sense for tests.',3),
    wikiPage('unbibulous','==English==\n# A synthetic descriptive adjective for tests.',4),wikiPage('tree','==English==\n# A woody plant.',2)];
  await runTick(env,{clock:()=>TEST_NOW,fetcher:fixtureSources({english}).fetcher});const store=new LabStore(env.DB);
  const all=await candidates(store,new URLSearchParams(),TEST_NOW);assert.equal(all.total,4);assert.equal(all.words[0].domain,'arna.com');assert.equal(all.words[1].domain,'tree.com');assert(all.words.every(w=>w.triage==='new'&&w.favorite===0));
  const rare=await candidates(store,new URLSearchParams({commonness:'source_flagged_rare'}),TEST_NOW);assert.deepEqual(rare.words.map(w=>w.domain),['systylious.com']);assert.equal(rare.words[0].evidence_status,'dictionary_definition_verified');
  const high=await candidates(store,new URLSearchParams({suitability:'high_friction'}),TEST_NOW);assert.equal(high.total,2);
  const consultant=await candidates(store,new URLSearchParams({persona:'Consultant'}),TEST_NOW);assert.equal(consultant.total,0);env.DB.close();
});
