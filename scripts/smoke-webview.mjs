/** Exercise the real TS client in WKWebView, not Node's permissive fetch implementation.
 * macOS only; requires Xcode Command Line Tools. Supports --root for extracted packages,
 * --client-source for regression checks against an earlier source, and --keep for diagnostics.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

if (process.platform !== 'darwin') {
  console.log('SKIP: native WKWebView smoke requires macOS');
  process.exit(0);
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : path.resolve(process.argv[index + 1]);
}
const root = arg('root', repo);
const clientSource = arg('client-source', path.join(repo, 'src/host/service.ts'));
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'concat webview 测试-'));
const env = { ...process.env };
delete env.FFMPEG_PATH;
delete env.FFPROBE_PATH;
function run(command, args, timeout = 30_000) {
  return execFileSync(command, args, { encoding: 'utf8', env, timeout, maxBuffer: 1024 * 1024 });
}
try {
  const input = path.join(workdir, '素材 video.mp4');
  const project = path.join(workdir, '工程 project.concatproj');
  run(path.join(root, 'resources/ffmpeg/macos/ffmpeg'), [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', input,
  ]);
  const compiled = ts.transpileModule(fs.readFileSync(clientSource, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText.replace(/^export /gm, '');
  const script = compiled + `
async function runWebviewProbe(origin, token) {
  const checks = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); checks.push(message); report({phase: 'progress', check: message}); };
  const report = (value) => window.webkit.messageHandlers.report.postMessage(value);
  const connection = {origin, token, async dispose() {}};
  const client = new ConcatdClient(connection);
  try {
    await client.status();
    check(true, 'Window.fetch receiver / health');
    const ready = await createReadyClient(connection);
    check(ready instanceof ConcatdClient, 'health-gated client');
    const media = await client.probe(${JSON.stringify(input)});
    check(media.info.kind === 'video' && media.info.hasAudio, 'video import / audio probe');
    for (const revision of [1, 2]) {
      const contents = JSON.stringify({version: 1, revision, title: '测试 project'});
      const bytes = new TextEncoder().encode(contents);
      await client.saveProject(${JSON.stringify(project)}, bytesToBase64(bytes));
      const loaded = await client.readProject(${JSON.stringify(project)});
      check(new TextDecoder().decode(base64ToBytes(loaded.dataBase64)) === contents, 'project save/open revision ' + revision);
    }
    await client.close();
    report({phase: 'done', engine: 'WKWebView', origin: location.origin, checks});
  } catch (error) {
    report({phase: 'error', message: String(error), checks});
  }
}`;
  const scriptFile = path.join(workdir, 'client.js');
  const harness = path.join(workdir, 'webview-smoke');
  fs.writeFileSync(scriptFile, script);
  run('xcrun', ['swiftc', '-swift-version', '5', path.join(repo, 'scripts/fixtures/webview-smoke.swift'), '-o', harness], 60_000);
  const log = run(harness, [path.join(root, 'bin/concatd-macos'), scriptFile], 85_000);
  const result = JSON.parse(log.trim().split('\n').at(-1));
  assert.equal(result.phase, 'done');
  assert.equal(result.checks.length, 5);
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (process.argv.includes('--keep')) console.log(`Retained diagnostics: ${workdir}`);
  else fs.rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
