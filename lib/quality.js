export const FIT_RULES = {
  'Hotel & Villa': {tokens:['home','house','rest','garden','guest','shelter','घर','बास','आराम','बगैँचा'],type:'industry',use:'A hospitality brand or a place to stay'},
  Technology: {tokens:['computer','system','data','network','digital','code','science','प्रविधि','सूचना'],type:'industry',use:'Software, data or technical services'},
  Education: {tokens:['learn','teach','knowledge','study','book','ज्ञान','शिक्षा','पढ'],type:'industry',use:'Learning resources or educational services'},
  Finance: {tokens:['money','trade','capital','wealth','coin','धन','पैसा','व्यापार'],type:'industry',use:'Financial education or a trading brand'},
  Fashion: {tokens:['cloth','dress','style','wear','beauty','fabric','लुगा','कपडा','सुन्दर'],type:'industry',use:'Clothing, design or a style publication'},
  Creator: {tokens:['create','art','music','write','story','idea','कला','सिर्जना','संगीत'],type:'persona',use:'A creative portfolio or publication'},
  Consultant: {tokens:['guide','advice','knowledge','skill','help','plan','solve','सल्लाह','ज्ञान','सीप'],type:'persona',use:'An advisory practice or specialist portfolio'},
  Photographer: {tokens:['light','image','picture','view','vision','scene','lens','प्रकाश','तस्बिर','दृश्य'],type:'persona',use:'A photography portfolio or image service'},
  Entrepreneur: {tokens:['build','create','trade','business','growth','start','व्यवसाय','व्यापार','निर्माण'],type:'persona',use:'A new business or independent project'}
};
export function fitTokenMatches(text,token) {
  if(/^[a-z]+$/.test(token)) {
    const words=new Set(String(text).toLowerCase().match(/[a-z]+/g)||[]);
    return words.has(token)||words.has(token+'s');
  }
  return String(text).includes(token);
}

export function brandSignals(word,meaning={}) {
  let labels=[];try{labels=Array.isArray(meaning.usage_labels)?meaning.usage_labels:JSON.parse(meaning.usage_labels||'[]')}catch{}
  const commonness=labels.some(x=>['rare','uncommon'].includes(x))?'source_flagged_rare':
    labels.some(x=>['archaic','obsolete','dated'].includes(x))?'source_flagged_dated':
      labels.some(x=>['technical','dialectal','nonstandard'].includes(x))?'source_flagged_specialist':'unknown';
  let score=35;const reasons=[];
  const lengthPoints=word.length<=5?30:word.length===6?24:word.length===7?15:word.length===8?7:0;
  score+=lengthPoints;reasons.push(`${word.length} letters: +${lengthPoints}; shorter spellings reduce typing effort.`);
  const vowels=/[aeiou]/.test(word);score+=vowels?8:0;
  reasons.push(vowels?'A written vowel is present: +8; spoken pronunciation is unverified.':'No standard written vowel; spoken spelling needs review.');
  let friction='low';
  const consonants=(word.match(/[^aeiouy]+/g)||[]).reduce((n,s)=>Math.max(n,s.length),0);
  if(consonants>=4){score-=20;friction='high';reasons.push('Four or more consecutive consonants: −20 spelling-friction signal.');}
  else if(consonants>=3){score-=9;friction='moderate';reasons.push('Three consecutive consonants: −9 spelling-friction signal.');}
  else{score+=10;reasons.push('No long consonant cluster: +10; ease of pronunciation is not established.');}
  if(word.length>=9){score-=12;friction=friction==='high'?'high':'moderate';reasons.push('Nine or ten letters: −12 for recall and typing effort.');}
  if(/(?:ough|eigh)/.test(word)){score-=10;friction='high';reasons.push('ough/eigh spelling pattern: −10; pronunciation can be ambiguous.');}
  if(labels.some(x=>['rare','uncommon'].includes(x))){score-=25;reasons.push('Dictionary explicitly marks a sense rare/uncommon: −25.');}
  if(labels.some(x=>['archaic','obsolete','dated'].includes(x))){score-=20;reasons.push('Dictionary marks a dated/archaic sense: −20.');}
  if(labels.some(x=>['technical','dialectal','nonstandard'].includes(x))){score-=12;reasons.push('Source marks specialist or nonstandard usage: −12.');}
  if(labels.some(x=>['offensive','vulgar'].includes(x))){score-=35;reasons.push('Source marks an offensive/vulgar sense: −35; context review required.');}
  if(commonness==='unknown')reasons.push('Commonness unknown: no usage-frequency evidence is connected.');
  if(meaning.language==='Nepali')reasons.push('Nepali practical spelling retains its separate method, reviewer and uncertainty record.');
  score=Math.max(0,Math.min(100,score));
  return {score,commonness,friction,labels,reasons,suitability:score>=75?'promising_signals':score>=55?'needs_review':'high_friction',
    pronunciationConfidence:'heuristic_only'};
}

export function qualityFor(word, meanings) {
  const text = meanings.map(m => m.definition+' '+(m.reviewed_definition||'')).join(' ').toLowerCase();
  const tags = Object.entries(FIT_RULES).flatMap(([tag, rule]) => {
    const matched = rule.tokens.filter(token => fitTokenMatches(text,token));
    return matched.length ? [{tag,type:rule.type,useCase:rule.use,explanation:`Definition contains: ${matched.join(', ')}.`}] : [];
  });
  const best=meanings.map(m=>brandSignals(word,m)).sort((a,b)=>b.score-a.score)[0]||brandSignals(word);
  return {tags,...best,scoreExplanation:best.reasons.join(' '),
    spelling:`${word.length} ASCII letters. ${/[aeiou]/.test(word) ? 'Contains a vowel; this does not establish pronunciation.' : 'No standard vowel; spoken spelling may be harder.'}`,
    pronunciation:meanings.some(m => m.language === 'Nepali') ? 'Practical ASCII spelling may lose vowel length, retroflex and v/w distinctions. Check with a Nepali speaker.' : 'Check pronunciation, alternate senses and spelling with the linked dictionary.',
    caveat:'No monetary valuation or trademark clearance is inferred.'};
}
