import test from 'node:test';
import assert from 'node:assert/strict';
import { marketPayload } from './publish-market.mjs';
import { parseDependencies } from './portable-runtime.mjs';
import { packageLayout } from './pack-plugin.mjs';

test('three-platform publication never advertises unbuilt architectures', () => {
  const p = marketPayload({packid:'otools-concat',version:'0.1.1',entry:'dist/index.html'},'ootools/otools-concat','v0.1.1','0.1.1',{platformPackages:true,platforms:['macos','windows','linux']});
  assert.match(p.packageUrlWindows, /-windows\.oplg$/);
  assert.match(p.packageUrlLinux, /-linux\.oplg$/);
  assert.match(p.packageUrlMacos, /-macos\.oplg$/);
  for (const key of ['packageUrlMacosIntel','packageUrlWindowsArm','packageUrlLinuxArm']) assert.equal(p[key], '');
  assert.equal(p.supportWindows,true);
  assert.equal(p.supportLinux,true);
});

test('each target gets its own directory and stable release filename', () => {
  assert.deepEqual(packageLayout('otools-concat','0.1.1','windows',true),{directory:'windows',filename:'otools-concat-0.1.1-windows.oplg'});
  assert.deepEqual(packageLayout('otools-concat','0.1.1','linux',true),{directory:'linux',filename:'otools-concat-0.1.1-linux.oplg'});
});

test('dependency inspection rejects unbundled MinGW DLLs and Linux codecs', () => {
  assert.deepEqual(parseDependencies('windows',' DLL Name: KERNEL32.dll\n DLL Name: msvcrt.dll'),['KERNEL32.dll','msvcrt.dll']);
  assert.throws(()=>parseDependencies('windows',' DLL Name: libwinpthread-1.dll'),/external/);
  assert.deepEqual(parseDependencies('linux',' 0x (NEEDED) Shared library: [libm.so.6]\n 0x (NEEDED) Shared library: [libc.so.6]'),['libc.so.6','libm.so.6']);
  assert.throws(()=>parseDependencies('linux',' 0x (NEEDED) Shared library: [libx264.so.164]'),/external/);
  assert.throws(()=>parseDependencies('windows','not a dependency report'),/empty/);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { binaryName } from './package-common.mjs';

test('Windows service filename includes .exe; Linux has no extension', () => {
  assert.equal(binaryName('concatd',{suffix:'windows',os:'win32'}),'concatd-windows.exe');
  assert.equal(binaryName('concatd',{suffix:'linux',os:'linux'}),'concatd-linux');
});

test('packaging fails before writing any ZIP when runtime metadata is invalid', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'concat-pack-reject-'));
  try {
    for(const dir of ['bin','dist','resources/ffmpeg/linux']) fs.mkdirSync(path.join(root,dir),{recursive:true});
    fs.writeFileSync(path.join(root,'plugin.json'),JSON.stringify({packid:'test',version:'0.1.1',entry:'dist/index.html',sidecars:[{id:'concatd',bin:'concatd'}]}));
    fs.writeFileSync(path.join(root,'logo.svg'),'<svg/>');
    fs.writeFileSync(path.join(root,'dist/index.html'),'otools');
    const elf=Buffer.alloc(64); elf.writeUInt32BE(0x7f454c46); elf[4]=2;elf[5]=1;elf.writeUInt16LE(2,16);elf.writeUInt16LE(62,18);
    fs.writeFileSync(path.join(root,'bin/concatd-linux'),elf);
    fs.writeFileSync(path.join(root,'resources/ffmpeg/linux/runtime.json'),'{}');
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('./pack-plugin.mjs',import.meta.url)),'--root',root,'--platforms','linux','--per-platform'],{encoding:'utf8'});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/Runtime source\/license record incomplete/);
    assert.equal(fs.existsSync(path.join(root,'dist-pack/linux/test-0.1.1-linux.oplg')),false);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

import { ffmpegMakeTargets } from './portable-runtime.mjs';
test('MinGW make uses .exe targets rather than nonexistent POSIX targets', () => {
  assert.deepEqual(ffmpegMakeTargets('windows'), ['ffmpeg.exe','ffprobe.exe']);
  assert.deepEqual(ffmpegMakeTargets('linux'), ['ffmpeg','ffprobe']);
});
