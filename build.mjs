import fs from 'node:fs';

fs.mkdirSync('dist/server',{recursive:true});
fs.mkdirSync('dist/.openai',{recursive:true});
const stripImports = text => text.replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];\s*\n/gm,'');
const modules = ['safety','profiles','romanization','dictionary','namecheap','quality','store','engine','candidates'];
const library = modules.map(name => stripImports(fs.readFileSync(`lib/${name}.js`,'utf8')).replace(/^export /gm,'')).join('\n');
const html = fs.readFileSync('index.html','utf8');
const client = fs.readFileSync('client.js','utf8');
fs.writeFileSync('dist/server/index.js',`const HTML=${JSON.stringify(html)};\nconst CLIENT=${JSON.stringify(client)};\n`+
  library+'\n'+stripImports(fs.readFileSync('worker.js','utf8')));
if(process.argv.includes('--cloudflare')){
  fs.mkdirSync('dist/cloudflare',{recursive:true});
  const common=stripImports(fs.readFileSync('worker.js','utf8')).replace(/^export default .*;\s*$/m,'');
  const access=stripImports(fs.readFileSync('lib/cloudflare-access.js','utf8')).replace(/^export /gm,'');
  fs.writeFileSync('dist/cloudflare/index.js',`const HTML=${JSON.stringify(html)};\nconst CLIENT=${JSON.stringify(client)};\n`+
    library+'\n'+access+'\n'+common+'\n'+stripImports(fs.readFileSync('cloudflare-worker.js','utf8')));
}
// Build output stays local. Private hosting metadata is never required for tests or committed.
if(fs.existsSync('.openai/hosting.json')) fs.copyFileSync('.openai/hosting.json','dist/.openai/hosting.json');
fs.cpSync('drizzle','dist/.openai/drizzle',{recursive:true});
console.log('Built a single Worker module and additive migration journal. No deployment performed.');
