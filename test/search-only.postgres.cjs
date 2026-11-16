// Real, isolated PostgreSQL function/constraint check. RLS requires a normal server. No sockets, Supabase URL or credentials.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const root = path.join(__dirname,'..');
const bin = process.env.GT_TEST_POSTGRES_BIN;
if (!bin || !path.isAbsolute(bin)) throw new Error('Set GT_TEST_POSTGRES_BIN to an isolated PostgreSQL bin directory. This test never connects to a server.');
const data = fs.mkdtempSync(path.join(os.tmpdir(),'goaltracker-tags-pg-'));
const library = path.join(bin,'../lib');
const env = { ...process.env, LD_LIBRARY_PATH: library + (process.env.LD_LIBRARY_PATH ? ':'+process.env.LD_LIBRARY_PATH : '') };
function run(executable,args,input='') {
    return new Promise((resolve,reject)=>{
        const child=spawn(path.join(bin,executable),args,{env,stdio:['pipe','pipe','pipe']});let output='';
        child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
        child.on('error',reject);
        child.on('close',code=>code!==0||/\b(?:ERROR|FATAL|PANIC):/.test(output)?reject(new Error(output)):resolve(output));
        child.stdin.end(input);
    });
}
const sql = file => fs.readFileSync(path.join(root,file),'utf8').split('\n').filter(line=>!line.trimStart().startsWith('--')).join(' ');
async function scenario(name, files) {
    const cluster=path.join(data,name);fs.mkdirSync(cluster);
    await run('initdb',['-D',cluster,'-A','trust','-U','test_owner','--no-locale','-E','UTF8']);
    await run('postgres',['--single','-D',cluster,'-c','wal_level=logical','-c','log_min_error_statement=panic','template1'],files.map(sql).join('\n')+'\n');
}
(async()=>{
    try {
        const base=['test/public-tags-fixture.sql','test/search-only-setup.sql'];
        const migration='supabase/migrations/20261023_search_nickname_only.sql';
        await scenario('user-id',[...base,migration,migration,'test/search-only-functional.sql']);
        await scenario('id',[...base,'test/search-only-id-column.sql',migration,migration,'test/search-only-functional.sql']);
        console.log('PASS: real PostgreSQL, search-only migration twice for profiles.user_id and profiles.id; exact/duplicate nickname lookup, minimal fields, self exclusion, avatar consent, no-session denial, unchanged rows and preserved policy.');
        console.log('NOT VERIFIED: RLS enforcement / live Supabase HTTP. No Supabase connection or migration performed.');
    } finally { fs.rmSync(data,{recursive:true,force:true}); }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
