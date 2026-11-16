// Prepare a static-hosting OTA release without network access or publication.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const root=path.join(__dirname,'..');process.chdir(root);
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const version=process.argv[2]||pkg.version.split('.').map((part,index)=>index===2?Number(part)+1:part).join('.');
if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Expected a numeric version');
const [major,minor,patch]=version.split('.').map(Number);
const androidVersionCode=major*1000000+minor*1000+patch;
if(!Number.isSafeInteger(androidVersionCode)||androidVersionCode>2100000000)throw Error('Android version code is out of range');
const configured=fs.readFileSync('ota-sync.js','utf8').match(/baseUrl:\s*'([^']+)'/)[1];
const base=new URL(process.argv[3]||configured);
if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw Error('Expected an HTTPS origin');
const changes='Независимая синхронизация целей, календаря, финансов, здоровья и остальных разделов; сохранение данных аккаунта.';
pkg.version=version;fs.writeFileSync('package.json',JSON.stringify(pkg,null,2)+'\n');
const androidGradle='android/app/build.gradle';
fs.writeFileSync(androidGradle,fs.readFileSync(androidGradle,'utf8')
 .replace(/versionCode\s+\d+/,`versionCode ${androidVersionCode}`)
 .replace(/versionName\s+"[^"]*"/,`versionName "${version}"`));
for(const file of ['package-lock.json','manifest.json']){
 const value=JSON.parse(fs.readFileSync(file,'utf8'));value.version=version;
 if(value.packages?.[''])value.packages[''].version=version;
 fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
}
for(const file of ['app.js','worker.js'])fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace(/const APP_VERSION = '[^']*'/,`const APP_VERSION = '${version}'`));
fs.writeFileSync('ota-sync.js',fs.readFileSync('ota-sync.js','utf8').replace(/baseUrl:\s*'[^']+'/,`baseUrl: '${base.origin}'`));
execFileSync('npm',['run','build:web'],{stdio:'inherit'});
const bundle=path.join(root,`update-${version}.zip`);
if(fs.existsSync(bundle))fs.unlinkSync(bundle);
execFileSync('zip',['-rq',bundle,'.','-x','version.json','updates/*','cordova.js','cordova_plugins.js','plugins/*'],{cwd:path.join(root,'www'),stdio:'inherit'});
if(fs.statSync(bundle).size>25*1024*1024)throw Error('Bundle exceeds the hosting size limit');
execFileSync('unzip',['-tq',bundle],{stdio:'inherit'});
const metadata={version,minVersion:'1.0.0',updateUrl:`${base.origin}/updates/latest.zip?version=${version}`,changelog:changes,mandatory:false,timestamp:new Date().toISOString(),checksum:crypto.createHash('sha256').update(fs.readFileSync(bundle)).digest('hex')};
for(const directory of ['www','public']){
 fs.mkdirSync(path.join(directory,'updates'),{recursive:true});fs.copyFileSync(bundle,path.join(directory,'updates/latest.zip'));
 fs.writeFileSync(path.join(directory,'version.json'),JSON.stringify(metadata,null,2)+'\n');
}
console.log(`Prepared ${version}. OTA origin: ${base.origin}. Nothing published.`);
