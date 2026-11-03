// Materialize disposable fixtures from the backend, web migrations and the monitoring probe.
// Never use runtime monitoring credentials here.
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';
const [back,web,status,dest]=process.argv.slice(2).map(x=>path.resolve(x));
if(!dest||fs.existsSync(dest))throw Error('a new fixture directory is required');
const here=path.dirname(fileURLToPath(import.meta.url));const ts=createRequire(path.join(back,'server/package.json'))('typescript');
fs.mkdirSync(dest,{mode:0o700});fs.mkdirSync(path.join(dest,'migrations'));
const pins=JSON.parse(fs.readFileSync(path.join(here,'fixtures-sha256.json')));
const copy=(p,out=path.basename(p))=>fs.copyFileSync(p,path.join(dest,out));
for(const [f,sha] of Object.entries(pins)){
 const p=path.join(web,f==='postgres-bootstrap.sql'?'scripts/supabase':'supabase/migrations',f);
 if(createHash('sha256').update(fs.readFileSync(p)).digest('hex')!==sha)throw Error('fixture drift: '+f);
 copy(p,f==='postgres-bootstrap.sql'?f:'migrations/'+f);
}
for(const [f,out] of [['griipClient.ts','griipClient.mjs'],['accounts.ts','managed-client.mjs']]){
 const src=fs.readFileSync(path.join(back,'server/test/support',f),'utf8');
 fs.writeFileSync(path.join(dest,out),ts.transpileModule(src,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replaceAll('./griipClient.js','./griipClient.mjs'));
}
for(const f of ['synthetics.mjs','transport.mjs'])copy(path.join(status,'monitor',f));
copy(path.join(back,'deploy/database-migration/owned-api-canary.mjs'));
for(const f of ['rehearse.py','standby-boot.mjs','owned-normal.mjs','park.mjs','client.mjs','handoff.mjs','owned-prepared-api.mjs','owned-pg-wire.mjs','owned-pg-latency.mjs'])copy(path.join(here,f));
