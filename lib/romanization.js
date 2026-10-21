// A deliberately small practical ASCII scheme. This is neither a linguistic standard nor source attestation.
const ROMAN_VOWELS = {'अ':'a','आ':'a','इ':'i','ई':'i','उ':'u','ऊ':'u','ए':'e','ऐ':'ai','ओ':'o','औ':'au'};
const ROMAN_MARKS = {'ा':'a','ि':'i','ी':'i','ु':'u','ू':'u','े':'e','ै':'ai','ो':'o','ौ':'au'};
const ROMAN_CONSONANTS = {'क':'k','ख':'kh','ग':'g','घ':'gh','ङ':'ng','च':'ch','छ':'chh','ज':'j','झ':'jh',
  'ञ':'ny','ट':'t','ठ':'th','ड':'d','ढ':'dh','ण':'n','त':'t','थ':'th','द':'d','ध':'dh','न':'n','प':'p',
  'फ':'ph','ब':'b','भ':'bh','म':'m','य':'y','र':'r','ल':'l','व':'v','श':'sh','ष':'sh','स':'s','ह':'h'};

export function proposeRomanization(native) {
  if (typeof native !== 'string' || !/^[\u0900-\u097f]{1,50}$/.test(native)) return {suggestion:'',method:'practical_ascii_v1',confidence:0,issues:['Unsupported spelling']};
  let suggestion = '';
  const issues = new Set();
  const chars = [...native.normalize('NFC')];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (ROMAN_VOWELS[char]) { suggestion += ROMAN_VOWELS[char]; continue; }
    if (!ROMAN_CONSONANTS[char]) { issues.add('Unsupported mark or phoneme needs a reviewer'); continue; }
    suggestion += ROMAN_CONSONANTS[char];
    if (char === 'व') issues.add('v/w spelling choice needs a reviewer');
    const next = chars[i + 1];
    if (next === '्') { i++; continue; }
    if (ROMAN_MARKS[next]) { suggestion += ROMAN_MARKS[next]; i++; continue; }
    // Inherent-vowel and terminal schwa choices depend on the word. They are never auto-approved.
    issues.add('Inherent-vowel or final-schwa choice needs a reviewer');
    if (i < chars.length - 1) suggestion += 'a';
  }
  if (!/^[a-z]{4,10}$/.test(suggestion)) issues.add('Practical spelling is outside the 4–10 letter queue');
  return {suggestion, method:'practical_ascii_v1',confidence:issues.size ? 0.55 : 0.93,issues:[...issues],
    explanation:'Deterministic practical ASCII mapping; long-vowel and retroflex distinctions are collapsed. Not source-attested or standardized.'};
}
