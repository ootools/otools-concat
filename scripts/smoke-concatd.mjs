/**
 * concatd 端到端冒烟（无需宿主）：spawn 二进制 → stdio 握手 → probe →
 * 缩略图 → 文字资产上传 → 渲染 2s 小样 → 校验输出。
 *
 * 用法：node scripts/smoke-concatd.mjs [--bin bin/concatd-macos]
 *      [--ffmpeg /path/to/ffmpeg] [--ffprobe /path/to/ffprobe] [--keep]
 * ffmpeg 缺省从 resources/ffmpeg/<platform>/ 或 uniplayer 仓的已验证运行时解析。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { once } from 'node:events';
import { currentPlatform, binaryName } from './package-common.mjs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(arg('root', path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const keep = process.argv.includes('--keep');

const target = currentPlatform();
function detectTool(name) {
  const supplied = arg(name, process.env[name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH']);
  return supplied || path.join(root, 'resources/ffmpeg', target.suffix, name + (target.os === 'win32' ? '.exe' : ''));
}
const ffmpeg = detectTool('ffmpeg');
const ffprobe = detectTool('ffprobe');
const bin = arg('bin', path.join(root, 'bin', binaryName('concatd', target)));

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}
const ok = (message) => console.log(`✓ ${message}`);

if (!fs.existsSync(bin)) fail(`concatd 不存在：${bin}（先 cargo build --release）`);

// —— 生成 2 段测试视频（1.5s，各带音轨与不同颜色/音调）——
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'concatd smoke 测试-'));
const run = (tool, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(tool, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.on('error', reject);
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-400)))));
  });

async function makeInputs() {
  const first = path.join(workdir, 'a.mp4');
  const second = path.join(workdir, 'b.mp4');
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1.5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', first]);
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'smptebars=size=320x240:rate=30:duration=1.5', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1.5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', second]);
  return [first, second];
}

// —— 最小 QOI 编码器（与 src/render/qoi.ts 同规范，仅供冒烟） ——
function makeQoi(width, height, paint) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = paint(x, y);
      const offset = (y * width + x) * 4;
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
      pixels[offset + 3] = a;
    }
  }
  const body = [];
  const index = new Uint8Array(64 * 4);
  let run = 0;
  let pr = 0, pg = 0, pb = 0, pa = 255;
  const push = (...values) => body.push(...values);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2], a = pixels[offset + 3];
    if (r === pr && g === pg && b === pb && a === pa) {
      run += 1;
      if (run === 62) { push(0xc0 | (run - 1)); run = 0; }
      continue;
    }
    if (run > 0) { push(0xc0 | (run - 1)); run = 0; }
    const slot = ((r * 3 + g * 5 + b * 7 + a * 11) % 64) * 4;
    if (index[slot] === r && index[slot + 1] === g && index[slot + 2] === b && index[slot + 3] === a) {
      push(slot / 4);
    } else if (a === pa) {
      const dr = (r - pr + 2) & 0xff, dg = (g - pg + 2) & 0xff, db = (b - pb + 2) & 0xff;
      if (dr < 4 && dg < 4 && db < 4) push(0x40 | (dr << 4) | (dg << 2) | db);
      else {
        const lg = (g - pg + 32) & 0xff;
        const lrg = (r - pg - (g - pg) + 8) & 0xff;
        const lbg = (b - pg - (g - pg) + 8) & 0xff;
        if (lg < 64 && lrg < 16 && lbg < 16) { push(0x80 | lg, (lrg << 4) | lbg); }
        else { push(0xfe, r, g, b); }
      }
    } else {
      push(0xff, r, g, b, a);
    }
    index[slot] = r; index[slot + 1] = g; index[slot + 2] = b; index[slot + 3] = a;
    pr = r; pg = g; pb = b; pa = a;
  }
  if (run > 0) push(0xc0 | (run - 1));
  const header = [0x71, 0x6f, 0x69, 0x66];
  const u32 = (value) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  return new Uint8Array([...header, ...u32(width), ...u32(height), 4, 0, ...body, 0, 0, 0, 0, 0, 0, 0, 1]);
}

// —— 握手 ——
function connect() {
  const token = [...new Uint8Array(32)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const child = spawn(bin, ['--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const port = new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('handshake timeout')), 15000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const line = buffer.split('\n').find((value) => value.trim());
      if (!line) return;
      try {
        const message = JSON.parse(line);
        if (message.event === 'ready') {
          clearTimeout(timer);
          resolve(message.port);
        }
      } catch {
        /* 继续等 */
      }
    });
    child.on('exit', (code) => reject(new Error(`concatd exited early (${code})`)));
  });
  // 与前端一致：init origin = webview 的 location.origin，后续请求带同值 Origin 头。
  const initOrigin = 'http://127.0.0.1:9';
  child.stdin.write(`${JSON.stringify({ type: 'init', token, origin: initOrigin })}\n`);
  return { child, token, port, initOrigin };
}

async function main() {
  ok(`concatd: ${bin}`);
  ok(`ffmpeg: ${ffmpeg}`);
  const connection = connect();
  const { child, token, port: portPromise, initOrigin } = connection;
  const port = await portPromise; // Starting the installed service must prepare bundled tool permissions.
  const [first, second] = await makeInputs();
  ok(`测试素材：${first}, ${second}`);

  const origin = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: initOrigin };
  const call = async (route, body, method) => {
    const response = await fetch(`${origin}${route}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${route} → HTTP ${response.status}: ${payload.error ?? ''}`);
    return payload;
  };
  ok(`握手成功：${origin}`);

  // Repeated save/open covers Windows overwrite semantics and Unicode paths.
  const projectFile = path.join(workdir, '工程 project.concatproj');
  for (const revision of [1, 2]) {
    const contents = JSON.stringify({ version: 1, revision });
    await call('/api/project', { path: projectFile, dataBase64: Buffer.from(contents).toString('base64') });
    const loaded = await call(`/api/project?path=${encodeURIComponent(projectFile)}`, undefined, 'GET');
    if (Buffer.from(loaded.dataBase64, 'base64').toString() !== contents) fail('project save/open mismatch');
  }
  ok('工程保存/覆盖/打开（Unicode + 空格路径）');

  // probe 两个素材
  const probeA = await call('/api/probe', { path: first });
  const probeB = await call('/api/probe', { path: second });
  if (probeA.info.kind !== 'video' || !probeA.info.hasAudio) fail('probe 结果缺视频/音轨');
  ok(`probe：${probeA.mediaId} (${probeA.previewMode}), ${probeB.mediaId} (${probeB.previewMode})`);

  // 缩略图（query token 通道）
  const thumbResponse = await fetch(`${origin}/api/media/${probeA.mediaId}/thumb.jpg?at=0.5&access_token=${token}`, { headers: { Origin: initOrigin } });
  if (!thumbResponse.ok) fail(`thumb → HTTP ${thumbResponse.status}`);
  ok(`缩略图 ${(await thumbResponse.arrayBuffer()).byteLength} bytes`);

  // 文字覆盖层：canvas 场景等价物 —— 320x240 半透明白条（RGBA→QOI，规范与 src/render/qoi.ts 一致）
  const overlay = makeQoi(320, 240, (x, y) => (y > 180 && x > 20 && x < 300 ? [255, 255, 255, 200] : [0, 0, 0, 0]));
  const text = await call('/api/assets/text', { dataBase64: Buffer.from(overlay).toString('base64') });
  ok(`文字覆盖层：${text.assetId} (QOI ${overlay.length} bytes)`);

  // 渲染：两段拼接 + 第二段 eq + 文字 overlay
  const output = path.join(workdir, 'out.mp4');
  const filterComplex = [
    '[0:v]trim=start=0.0:end=1.0,setpts=(PTS-STARTPTS)/1.0,scale=320:240:force_original_aspect_ratio=decrease,pad=320:240:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v0]',
    '[1:v]trim=start=0.5:end=1.5,setpts=(PTS-STARTPTS)/1.0,eq=saturation=0.5,scale=320:240:force_original_aspect_ratio=decrease,pad=320:240:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v1]',
    '[v0][v1]concat=n=2:v=1:a=0[base]',
    '[0:a]atrim=start=0.0:end=1.0,asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo[a0]',
    '[1:a]atrim=start=0.5:end=1.5,asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo[a1]',
    '[a0][a1]concat=n=2:v=0:a=1[amain]',
    '[amain]volume=0.8',
    '[base][2:v]overlay=0:0:enable=\'between(t,0.5,1.5)\'',
  ].join(';');
  const render = await call('/api/render', {
    inputs: [{ path: first }, { path: second }, { path: `asset:${text.assetId}`, loopImage: true, imageDuration: 1 }],
    filterComplex,
    expectedDuration: 2,
    output,
    quality: 'medium',
    hasAudio: true,
  });
  ok(`渲染任务：${render.renderId}`);

  // 轮询进度（SSE 兜底轮询通道）
  const deadline = Date.now() + 60_000;
  let finalState = 'running';
  let lastPercent = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const status = await call(`/api/render/${render.renderId}`);
    if (typeof status.percent === 'number' && status.percent !== lastPercent) {
      lastPercent = status.percent;
      process.stdout.write(`  渲染 ${Math.round(status.percent)}%\r`);
    }
    if (status.state !== 'running') {
      finalState = status.state;
      if (status.message) console.error('  诊断:', status.message);
      break;
    }
  }
  process.stdout.write('\n');
  if (finalState !== 'done') fail(`渲染未完成：${finalState}`);
  ok(`渲染完成：${output} (${fs.statSync(output).size} bytes)`);

  // 校验输出时长/编码
  const probeOutput = JSON.parse(
    new TextDecoder().decode(
      (await new Promise((resolve, reject) => {
        const childProcess = spawn(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-print_format', 'json', output], { stdio: ['ignore', 'pipe', 'ignore'] });
        const chunks = [];
        childProcess.stdout.on('data', (chunk) => chunks.push(chunk));
        childProcess.on('close', () => resolve(Buffer.concat(chunks)));
        childProcess.on('error', reject);
      })),
    ),
  );
  const duration = Number(probeOutput.format.duration);
  const hasVideo = probeOutput.streams.some((stream) => stream.codec_type === 'video' && stream.codec_name === 'h264');
  const hasAudio = probeOutput.streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac');
  if (!(duration > 1.8 && duration < 2.3)) fail(`输出时长异常：${duration}`);
  if (!hasVideo || !hasAudio) fail('输出缺 h264 视频或 aac 音轨');
  ok(`输出校验：duration=${duration.toFixed(2)}s, h264+aac ✓`);

  await call('/api/close', {});
  const closed = once(child, 'exit');
  child.stdin.end();
  const timeout = setTimeout(() => child.kill(), 5000);
  await closed;
  clearTimeout(timeout);
  if (keep) {
    ok(`保留工作目录：${workdir}`);
  } else {
    fs.rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  ok('冒烟全部通过');
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
