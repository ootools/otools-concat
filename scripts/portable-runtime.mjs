/** Build the locked sources on Linux, then certify by executing on the target OS. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireSource, extractSource, runBuild, recordFile } from './build-media-runtime.mjs';
import { verifyExecutable } from './package-common.mjs';
import { validateRuntimeMetadata } from './runtime-metadata.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (tool,args,options={}) => execFileSync(tool,args,{encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe'],...options});
const targets = { linux: { os:'linux', arch:'x64', host:'x86_64-linux-gnu', prefix:'', targetOS:'linux' }, windows: { os:'win32', arch:'x64', host:'x86_64-w64-mingw32', prefix:'x86_64-w64-mingw32-', targetOS:'mingw32' } };

export function parseDependencies(suffix, report) {
  const pattern = suffix === 'windows' ? /DLL Name:\s*(\S+)/g : /\(NEEDED\).*\[([^\]]+)\]/g;
  const dependencies = [...new Set([...report.matchAll(pattern)].map(m=>m[1]))].sort();
  if (!dependencies.length) throw new Error('Dependency report is empty');
  const linux = /^(libc\.so\.6|libm\.so\.6|libpthread\.so\.0|libdl\.so\.2|librt\.so\.1|libgcc_s\.so\.1|ld-linux-x86-64\.so\.2)$/;
  const windows = /^(avicap32|kernel32|msvcrt|ucrtbase|advapi32|bcrypt|crypt32|ole32|oleaut32|shell32|shlwapi|user32|gdi32|ws2_32|secur32|ntdll|version|winmm|avrt|mfplat|mfuuid|strmiids|dxgi|d3d11|d3d12|dxva2|ksuser)\.dll$|^api-ms-win-[a-z0-9-]+\.dll$/i;
  for(const name of dependencies) if (!(suffix === 'windows' ? windows : linux).test(name)) throw new Error(`Runtime has external dynamic dependency: ${name}`);
  return dependencies;
}

export function ffmpegMakeTargets(suffix) {
  return ['ffmpeg', 'ffprobe'].map(name => name + (suffix === 'windows' ? '.exe' : ''));
}

async function build(suffix) {
  const target=targets[suffix];
  if (!target || process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Portable build requires Linux x64 and target linux/windows');
  const lockBytes=await fs.readFile(path.join(root,'runtime-source-lock.json'));
  const lock=JSON.parse(lockBytes);
  const cache=path.join(root,'.media-runtime-cache'); await fs.mkdir(cache,{recursive:true});
  const archives={}, sources={}, builds={}, sha256={};
  for(const name of ['ffmpeg','x264']) {
    archives[name]=await acquireSource(name,lock.sources[name],undefined,cache);
    sources[name]=await extractSource(name,archives[name],cache);
    builds[name]=await fs.mkdtemp(path.join(cache,`${suffix}-${name}-`));
  }
  const prefix=path.join(builds.x264,'install');
  const env={...process.env,PATH:'/usr/bin:/bin',LC_ALL:'C',PKG_CONFIG_PATH:'',PKG_CONFIG_LIBDIR:path.join(prefix,'lib/pkgconfig'),PKG_CONFIG_SYSROOT_DIR:''};
  const cc=target.prefix+'gcc', cxx=target.prefix+'g++';
  const x264Configure=[`--prefix=${prefix}`,`--host=${target.host}`,'--enable-static','--enable-pic','--disable-cli','--disable-opencl','--disable-avs','--disable-swscale','--disable-lavf','--disable-ffms','--disable-gpac','--disable-lsmash','--bit-depth=all',...(target.prefix?[`--cross-prefix=${target.prefix}`]:[])];
  await runBuild('/bin/bash',[path.join(sources.x264,'configure'),...x264Configure],builds.x264,env,'Configure x264',path.join(builds.x264,'configure.log'));
  await runBuild('/usr/bin/make',['-j4','install-lib-static'],builds.x264,env,'Build x264',path.join(builds.x264,'make.log'));
  const ffmpegConfigure=[`--prefix=${path.join(builds.ffmpeg,'install')}`,`--target-os=${target.targetOS}`,'--arch=x86_64',`--cc=${cc}`,`--cxx=${cxx}`,'--enable-static','--disable-shared','--disable-autodetect','--enable-gpl','--enable-version3','--enable-libx264','--disable-network','--disable-opencl','--disable-ffplay','--disable-doc','--enable-ffmpeg','--enable-ffprobe','--pkg-config=/usr/bin/pkg-config','--pkg-config-flags=--static',`--extra-cflags=-I${prefix}/include`,`--extra-ldflags=${target.prefix?'-static -static-libgcc -static-libstdc++ ':''}-L${prefix}/lib`,...(target.prefix?['--enable-cross-compile',`--cross-prefix=${target.prefix}`]:[])];
  await runBuild('/bin/bash',[path.join(sources.ffmpeg,'configure'),...ffmpegConfigure],builds.ffmpeg,env,'Configure FFmpeg',path.join(builds.ffmpeg,'configure.log'));
  await runBuild('/usr/bin/make',['-j4',...ffmpegMakeTargets(suffix)],builds.ffmpeg,env,'Build FFmpeg',path.join(builds.ffmpeg,'make.log'));
  const directory=path.join(root,'resources/ffmpeg',suffix); await fs.mkdir(directory,{recursive:true});
  const extension=suffix==='windows'?'.exe':'';
  const dependencies=new Set();
  for(const name of ['ffmpeg','ffprobe']) {
    const binary=name+extension;
    const source=path.join(builds.ffmpeg,binary);
    run(target.prefix+'strip',[source]);
    const bytes=await fs.readFile(source); verifyExecutable(bytes,{suffix,...target});
    await recordFile(directory,binary,bytes,sha256); await fs.chmod(path.join(directory,binary),0o755);
    const report=run(suffix==='windows'?target.prefix+'objdump':'readelf',suffix==='windows'?['-p',source]:['-d',source]);
    for(const library of parseDependencies(suffix,report)) dependencies.add(library);
    await recordFile(directory,`sources/${name}-dependencies.txt`,report,sha256);
  }
  for(const name of ['ffmpeg','x264']) {
    await recordFile(directory,`sources/${lock.sources[name].archive}`,await fs.readFile(archives[name]),sha256);
    for(const license of lock.sources[name].licenseFiles) await recordFile(directory,name==='ffmpeg'?`licenses/${license}`:`licenses/x264/${license}`,await fs.readFile(path.join(sources[name],license)),sha256);
    await recordFile(directory,`sources/${name}-config.h`,await fs.readFile(path.join(builds[name],'config.h')),sha256);
    await recordFile(directory,`sources/${name}-config.mak`,await fs.readFile(path.join(builds[name],name==='ffmpeg'?'ffbuild/config.mak':'config.mak')),sha256);
  }
  for(const name of ['portable-runtime.mjs','build-media-runtime.mjs','verify-media-runtime.mjs','runtime-metadata.mjs','package-common.mjs']) await recordFile(directory,`sources/${name}`,await fs.readFile(path.join(root,'scripts',name)),sha256);
  await recordFile(directory,'sources/runtime-source-lock.json',lockBytes,sha256);
  const metadata={schema:1,platform:suffix,architecture:'x64',version:lock.sources.ffmpeg.version,configure:ffmpegConfigure.join(' '),license:'GPL-3.0-or-later',
    source:Object.fromEntries(['ffmpeg','x264'].map(name=>[name,{...lock.sources[name],archive:`sources/${lock.sources[name].archive}`,configure:name==='ffmpeg'?ffmpegConfigure:x264Configure}])),
    sourceArchives:['ffmpeg','x264'].map(name=>({name,path:`sources/${lock.sources[name].archive}`,sha256:lock.sources[name].sha256})),
    build:{toolchain:run(cc,['--version']).split('\n')[0],target:target.host,jobs:4},
    sha256,dynamicLibraries:[...dependencies].sort().map(library=>({path:library,system:true})),selfContained:false,redistributable:false};
  await fs.writeFile(path.join(directory,'runtime.json'),JSON.stringify(metadata,null,2)+'\n');
  console.log(`Built ${suffix}; native certification is required before packaging`);
}

async function certify(suffix) {
  const target=targets[suffix];
  if(!target || process.platform!==target.os || process.arch!==target.arch) throw new Error('Runtime must be certified on its native OS/architecture');
  const directory=path.join(root,'resources/ffmpeg',suffix);
  const metadata=await validateRuntimeMetadata(root,{suffix,...target});
  const lock=JSON.parse(await fs.readFile(path.join(root,'runtime-source-lock.json'),'utf8'));
  const extension=suffix==='windows'?'.exe':'';
  for(const name of ['ffmpeg','x264']) if(metadata.source[name].sha256!==lock.sources[name].sha256) throw new Error('Source does not match repository lock');
  const dependencies=new Set();
  for(const tool of ['ffmpeg','ffprobe']) {
    const bytes=await fs.readFile(path.join(directory,tool+extension)); verifyExecutable(bytes,{suffix,...target});
    for(const dependency of parseDependencies(suffix,await fs.readFile(path.join(directory,`sources/${tool}-dependencies.txt`),'utf8'))) dependencies.add(dependency);
  }
  if(JSON.stringify(metadata.dynamicLibraries)!==JSON.stringify([...dependencies].sort().map(library=>({path:library,system:true})))) throw new Error('Dependency metadata mismatch');
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'concat runtime 空格-'));
  const env=process.platform==='win32'?{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,PATH:path.join(process.env.SystemRoot,'System32'),TEMP:temporary,TMP:temporary}:{PATH:'/usr/bin:/bin',HOME:temporary,TMPDIR:temporary,LC_ALL:'C'};
  try {
    for(const name of ['ffmpeg','ffprobe']) { await fs.copyFile(path.join(directory,name+extension),path.join(temporary,name+extension)); await fs.chmod(path.join(temporary,name+extension),0o755); }
    const ffmpeg=path.join(temporary,'ffmpeg'+extension), ffprobe=path.join(temporary,'ffprobe'+extension);
    const isolated=(tool,args)=>run(tool,args,{env,cwd:temporary});
    const version=isolated(ffmpeg,['-version']);
    if(version.match(/^ffmpeg version (\S+)/m)?.[1]!==metadata.version) throw new Error('Native runtime version mismatch');
    const sample=path.join(temporary,'测试 movie.mp4');
    isolated(ffmpeg,['-v','error','-nostdin','-y','-f','lavfi','-i','testsrc2=size=320x240:rate=30:duration=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',sample]);
    const info=JSON.parse(isolated(ffprobe,['-v','error','-show_streams','-show_format','-of','json',sample]));
    if(!info.streams.some(s=>s.codec_name==='h264')||!info.streams.some(s=>s.codec_name==='aac')||Math.abs(Number(info.format.duration)-1)>.15) throw new Error('Native encode/probe failed');
    isolated(ffmpeg,['-v','error','-nostdin','-xerror','-i',sample,'-f','null','-']);
    metadata.selfContained=true; metadata.redistributable=true;
    metadata.verification={verifiedAt:new Date().toISOString(),platform:process.platform,architecture:process.arch,relocated:true,restrictedPath:true,unicodePaths:true,operations:['h264-aac-encode','probe','decode']};
    await fs.writeFile(path.join(directory,'runtime.json'),JSON.stringify(metadata,null,2)+'\n');
    await validateRuntimeMetadata(root,{suffix,...target},{formal:true});
    console.log(`Native ${suffix} runtime certification passed`);
  } finally { await fs.rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:200}); }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const [action,suffix]=process.argv.slice(2);
    if(action==='build') await build(suffix);
    else if(action==='certify') await certify(suffix);
    else throw new Error('Usage: portable-runtime.mjs build|certify linux|windows');
  } catch(error) { console.error(error.message); if(error.stderr) console.error(error.stderr.toString()); process.exitCode=1; }
}
