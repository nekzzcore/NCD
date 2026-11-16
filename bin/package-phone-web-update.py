#!/usr/bin/env python3
"""Package JS/assets updates using the existing compatible native debug APK."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json, os, re, shutil, subprocess, tempfile
from apk_manifest_version import update_manifest_version

root=Path(__file__).resolve().parent.parent
os.chdir(root)
sdk=Path(os.environ.get('ANDROID_HOME',str(Path.home()/'android-sdk')))
tools=sdk/'build-tools/35.0.0'
env=dict(os.environ);env.setdefault('JAVA_HOME',str(Path.home()/'jdk-21.0.2'))
source=root/'android/app/build/outputs/apk/debug/app-debug.apk'
assets=root/'android/app/src/main/assets'
version=json.loads((root/'package.json').read_text())['version']
if not re.fullmatch(r'\d+\.\d+\.\d+',version):raise RuntimeError('Invalid version')
if not source.is_file():raise RuntimeError('Build a native APK first')
major,minor,patch=map(int,version.split('.'));version_code=major*1000000+minor*1000+patch

def certificate(apk):
    result=subprocess.run([str(tools/'apksigner'),'verify','--print-certs',str(apk)],env=env,check=True,capture_output=True,text=True)
    return re.search(r'Signer #1 certificate SHA-256 digest: (\w+)',result.stdout)[1]

original_cert=certificate(source)
with tempfile.TemporaryDirectory(prefix='ncd-web-apk-') as temporary:
    work=Path(temporary)
    with ZipFile(source) as old, ZipFile(work/'unsigned.apk','w',compression=ZIP_DEFLATED) as new:
        native_plugins=json.loads(old.read('assets/capacitor.plugins.json'))
        copied_plugins=json.loads((assets/'capacitor.plugins.json').read_text())
        if native_plugins!=copied_plugins:raise RuntimeError('Native plugins changed: a full Gradle build is required')
        native_config=json.loads(old.read('assets/capacitor.config.json'))
        current_config=json.loads((assets/'capacitor.config.json').read_text())
        if native_config!=current_config:raise RuntimeError('Native config changed: a full Gradle build is required')
        old_types={info.filename:info.compress_type for info in old.infolist()}
        for info in old.infolist():
            if info.filename.startswith('assets/public/'):continue
            if re.match(r'META-INF/.*\.(SF|RSA|DSA|EC|MF)$',info.filename,re.I):continue
            payload=old.read(info.filename)
            if info.filename=='AndroidManifest.xml':payload=update_manifest_version(payload,version_code,version)
            new.writestr(info,payload)
        for file in (assets/'public').rglob('*'):
            if not file.is_file():continue
            relative=file.relative_to(assets/'public').as_posix()
            if relative.startswith('updates/'):continue
            name='assets/public/'+relative
            new.write(file,name,compress_type=old_types.get(name,ZIP_DEFLATED))
    subprocess.run([str(tools/'zipalign'),'-P','16','-f','4',str(work/'unsigned.apk'),str(work/'aligned.apk')],check=True)
    subprocess.run([str(tools/'apksigner'),'sign','--ks',str(Path.home()/'.android/debug.keystore'),'--ks-key-alias','androiddebugkey','--ks-pass','pass:android','--key-pass','pass:android','--out',str(work/'signed.apk'),str(work/'aligned.apk')],env=env,check=True)
    if certificate(work/'signed.apk')!=original_cert:raise RuntimeError('Signing certificate mismatch')
    with ZipFile(work/'signed.apk') as verified:
        if verified.testzip() is not None:raise RuntimeError('Damaged APK')
        if f"const APP_VERSION = '{version}'" not in verified.read('assets/public/app.js').decode():raise RuntimeError('Bundle version mismatch')
        # Native code and resources are retained byte-for-byte.
        with ZipFile(source) as old:
            for name in old.namelist():
                if not name.startswith(('assets/','META-INF/')) and not name.endswith('/'):
                    expected=update_manifest_version(old.read(name),version_code,version) if name=='AndroidManifest.xml' else old.read(name)
                    if expected!=verified.read(name):raise RuntimeError('Unexpected native change')
    badging=subprocess.run([str(tools/'aapt'),'dump','badging',str(work/'signed.apk')],check=True,capture_output=True,text=True).stdout
    if f"versionCode='{version_code}'" not in badging or f"versionName='{version}'" not in badging:raise RuntimeError('Native version verification failed')
    destination=root/'dist'/f'NCD-{version}.apk';destination.parent.mkdir(exist_ok=True)
    shutil.copy2(work/'signed.apk',destination)
    desktop=Path.home()/'Desktop'
    if desktop.is_dir():shutil.copy2(destination,desktop/destination.name)
    print(f'APK verified, same signing certificate: {destination}')
