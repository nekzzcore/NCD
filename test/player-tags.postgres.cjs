// Isolated PostgreSQL only: never opens a network connection or reads cloud credentials.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const bin = process.env.GT_TEST_POSTGRES_BIN;
if (!bin || !path.isAbsolute(bin)) throw new Error('Set GT_TEST_POSTGRES_BIN to an isolated PostgreSQL bin directory.');
const root = path.join(__dirname,'..');
const cluster = fs.mkdtempSync(path.join(os.tmpdir(),'ncd-player-tags-'));
const env = {...process.env,LD_LIBRARY_PATH:path.join(bin,'../lib')+(process.env.LD_LIBRARY_PATH?':'+process.env.LD_LIBRARY_PATH:'')};
function run(name,args,input='') {
 return new Promise((resolve,reject)=>{
  const child=spawn(path.join(bin,name),args,{env,stdio:['pipe','pipe','pipe']});let output='';
  child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  child.on('error',reject);child.on('close',code=>code||/\b(?:ERROR|FATAL|PANIC):/.test(output)?reject(new Error(output)):resolve());
  child.stdin.end(input);
 });
}
const sql=file=>fs.readFileSync(path.join(root,file),'utf8').split('\n').filter(line=>!line.trimStart().startsWith('--')).join(' ');
(async()=>{
 try {
  await run('initdb',['-D',cluster,'-A','trust','-U','test_owner','--no-locale','-E','UTF8']);
  const migration=sql('supabase/migrations/20261025_player_tags.sql');
  await run('postgres',['--single','-D',cluster,'-c','log_min_error_statement=panic','template1'],[
   sql('test/player-tags-fixture.sql'),migration,
   'create table public.player_tags_snapshot as select * from public.profiles;',
   migration,sql('test/player-tags-functional.sql')
  ].join('\n')+'\n');
  console.log('PASS: signup generation, uniqueness, reserved IDs, immutable IDs, repeated migration, strict lookup and social RPC identity mapping.');
  console.log('NOT VERIFIED: concurrent transactions and RLS on a normal server.');
 } finally {fs.rmSync(cluster,{recursive:true,force:true});}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
