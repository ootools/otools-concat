/** Exercise the archive as installed: all files 0644, only declared sidecars executable. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readZip } from './verify-plugin.mjs';
import { currentPlatform, binaryName } from './package-common.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const target=currentPlatform();
const manifest=JSON.parse(fs.readFileSync(path.join(root,'plugin.json'),'utf8'));
const packageFile=process.argv[2]||path.join(root,'dist-pack',target.suffix,`${manifest.packid}-${manifest.version}-${target.suffix}.oplg`);
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'concat installed 包-'));
try {
  for(const entry of readZip(fs.readFileSync(packageFile))) {
    const file=path.resolve(directory,entry.name);
    if(!file.startsWith(directory+path.sep)) throw new Error('Unsafe archive entry');
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,entry.data,{mode:0o644});
  }
  fs.chmodSync(path.join(directory,'bin',binaryName('concatd',target)),0o755);
  const env={...process.env}; delete env.FFMPEG_PATH;delete env.FFPROBE_PATH;
  execFileSync(process.execPath,[path.join(root,'scripts/smoke-concatd.mjs'),'--root',directory],{env,stdio:'inherit',timeout:90000});
  console.log(`Installed archive smoke passed: ${target.suffix}`);
} finally { fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:200}); }
