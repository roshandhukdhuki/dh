import fs from 'node:fs';
fs.mkdirSync('dist/server',{recursive:true});fs.mkdirSync('dist/.openai',{recursive:true});
const seed=JSON.parse(fs.readFileSync('seed.json','utf8'));
const html=fs.readFileSync('index.html','utf8');
const manual=fs.readFileSync('manual-batches.js','utf8').replace(/^export /gm,'');
const worker=fs.readFileSync('worker.js','utf8').replace(/^import[^\n]+from '\.\/manual-batches\.js';\n/,'');
fs.writeFileSync('dist/server/index.js',`const SEED=${JSON.stringify(seed)};\nconst HTML=${JSON.stringify(html)};\n`+manual+'\n'+worker);
// Private deployment metadata is optional and must never be committed.
if(fs.existsSync('.openai/hosting.json')) fs.copyFileSync('.openai/hosting.json','dist/.openai/hosting.json');fs.cpSync('drizzle','dist/.openai/drizzle',{recursive:true});
