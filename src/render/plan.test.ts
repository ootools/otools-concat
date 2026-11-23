/** buildRenderPlan 纯函数单测（node --test --experimental-strip-types）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRenderPlan, atempoChain, PlanError, filterCss } from './plan.ts';
import { emptyProject, type Clip, type ConcatProject, type RegisteredAsset } from '../types.ts';

function asset(id: string, kind: RegisteredAsset['info']['kind'], duration = 10, hasAudio = true): RegisteredAsset {
  return {
    id,
    path: `/tmp/${id}.mp4`,
    previewMode: 'browser',
    info: {
      name: `${id}.mp4`,
      duration,
      kind,
      videoCodec: kind === 'video' ? 'h264' : undefined,
      width: 1920,
      height: 1080,
      hasAudio,
      audioTracks: hasAudio ? [{ id: 0, label: 'a', codec: 'aac' }] : [],
    },
  };
}

function clipWith(partial: Partial<Clip>): Clip {
  return {
    id: partial.id ?? 'c1',
    trackId: partial.trackId ?? 'video-1',
    assetId: partial.assetId ?? 'm1',
    start: partial.start ?? 0,
    duration: partial.duration ?? 4,
    in: partial.in ?? 0,
    out: partial.out ?? 4,
    speed: partial.speed ?? 1,
    volume: partial.volume ?? 1,
    muted: partial.muted ?? false,
    filter: partial.filter,
    text: partial.text,
  };
}

function projectWith(clips: Clip[], media: RegisteredAsset[] = []): ConcatProject {
  const base = emptyProject();
  base.clips = clips;
  base.media = media;
  return base;
}

test('atempo 链拆分：2..4 → 两段 2.0', () => {
  assert.deepEqual(atempoChain(1), []);
  assert.deepEqual(atempoChain(4), ['atempo=2.0', 'atempo=2.0']);
  assert.deepEqual(atempoChain(0.25), ['atempo=0.5', 'atempo=0.5']);
  assert.deepEqual(atempoChain(1.5), ['atempo=1.5000']);
  assert.deepEqual(atempoChain(2), ['atempo=2.0']);
  assert.deepEqual(atempoChain(8), ['atempo=2.0', 'atempo=2.0', 'atempo=2.0']);
});

test('单视频片段：trim+setpts+scale+pad+fps，视频输出无标签（自动映射）', () => {
  const plan = buildRenderPlan({
    project: projectWith([clipWith({})], [asset('m1', 'video')]),
    asset: () => asset('m1', 'video'),
    textAsset: () => undefined,
  });
  assert.equal(plan.inputs.length, 1);
  assert.equal(plan.inputs[0].path, '/tmp/m1.mp4');
  assert.match(plan.filterComplex, /\[0:v\]trim=start=0\.0:end=4\.0,setpts=\(PTS-STARTPTS\)\/1\.0,/);
  assert.match(plan.filterComplex, /scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080/);
  assert.match(plan.filterComplex, /fps=30,format=yuv420p\[v0\]/);
  assert.match(plan.filterComplex, /\[v0\]null\[base\]/);
  // 无文字时 base null 收尾（视频输出无标签）
  assert.match(plan.filterComplex, /;\[base\]null$/);
  // 有音源：单音频链直接作为输出（无尾部标签）
  // 单音源：音频链无尾部标签（自动映射），后随分号
  assert.match(plan.filterComplex, /\[0:a\]atrim=start=0\.0:end=4\.0,asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo;/);
  assert.equal(plan.hasAudio, true);
  assert.equal(plan.expectedDuration, 4);
});

test('多片段：concat 视频与音频，静音片段补 anullsrc', () => {
  const media = [asset('m1', 'video'), asset('m2', 'video', 8, false)];
  const plan = buildRenderPlan({
    project: projectWith(
      [
        clipWith({ id: 'c1', assetId: 'm1', start: 0, duration: 4, in: 0, out: 4 }),
        clipWith({ id: 'c2', assetId: 'm2', start: 4, duration: 3, in: 1, out: 4, muted: false }),
      ],
      media,
    ),
    asset: (id) => media.find((item) => item.id === id),
    textAsset: () => undefined,
  });
  // 输入：m1 + m2 + anullsrc（m2 无声补位）
  assert.equal(plan.inputs.length, 3);
  assert.equal(plan.inputs[1].path, '/tmp/m2.mp4');
  assert.deepEqual(plan.inputs[2], { lavfi: 'anullsrc=r=48000:cl=stereo', duration: 3 });
  assert.match(plan.filterComplex, /\[v0\]\[v1\]concat=n=2:v=1:a=0\[base\]/);
  assert.match(plan.filterComplex, /\[2:a\]anull\[a2\]/);
  // 唯一音源：concat 输出无标签（自动映射）
  assert.match(plan.filterComplex, /\[a0\]\[a2\]concat=n=2:v=0:a=1;/);
});

test('变速片段：setpts 除以 speed，音频 atempo 链', () => {
  const plan = buildRenderPlan({
    project: projectWith([clipWith({ speed: 2, duration: 2, in: 0, out: 4 })], [asset('m1', 'video')]),
    asset: () => asset('m1', 'video'),
    textAsset: () => undefined,
  });
  assert.match(plan.filterComplex, /setpts=\(PTS-STARTPTS\)\/2/);
  assert.match(plan.filterComplex, /atempo=2\.0/);
  assert.equal(plan.expectedDuration, 2);
});

test('图片片段：-loop 输入 + 无 trim 链', () => {
  const media = [asset('img1', 'image', 0, false)];
  const plan = buildRenderPlan({
    project: projectWith([clipWith({ assetId: 'img1', duration: 5 })], media),
    asset: (id) => media.find((item) => item.id === id),
    textAsset: () => undefined,
  });
  assert.deepEqual(plan.inputs[0], { path: '/tmp/img1.mp4', loopImage: true, imageDuration: 5 });
  assert.doesNotMatch(plan.filterComplex, /trim=/);
  assert.match(plan.filterComplex, /\[0:v\]scale=1920:1080:force_original_aspect_ratio=decrease/);
  assert.equal(plan.hasAudio, false);
});

test('滤镜 eq：brightness 显示值 1 → eq brightness=0；非默认值进链', () => {
  const plan = buildRenderPlan({
    project: projectWith([clipWith({ filter: { brightness: 1.1, contrast: 1, saturation: 0 } })], [asset('m1', 'video')]),
    asset: () => asset('m1', 'video'),
    textAsset: () => undefined,
  });
  assert.match(plan.filterComplex, /eq=brightness=0\.1:saturation=0/);
  assert.doesNotMatch(plan.filterComplex, /eq=[^,]*contrast/);
  assert.equal(filterCss({ ...(emptyProject().clips[0] ?? clipWith({})), filter: { brightness: 1.1, contrast: 1, saturation: 0 } }), 'brightness(1.1) contrast(1) saturate(0)');
});

test('文字 overlay：asset 引用 + enable 时间窗；音频轨 adelay 混音', () => {
  const media = [asset('m1', 'video')];
  const project = projectWith(
    [
      clipWith({ assetId: 'm1', duration: 6 }),
      clipWith({ id: 't1', trackId: 'text-1', assetId: undefined, start: 1, duration: 2, text: { content: 'Hi', fontSize: 64, color: '#fff', strokeColor: '#000', strokeWidth: 0, bold: true, italic: false, align: 'center', x: 0.5, y: 0.5 } }),
      clipWith({ id: 'a1', trackId: 'audio-1', assetId: 'm1', start: 2, duration: 3, in: 0, out: 3 }),
    ],
    media,
  );
  const plan = buildRenderPlan({
    project,
    asset: (id) => media.find((item) => item.id === id),
    textAsset: (clipId) => (clipId === 't1' ? 'asset:text1' : undefined),
  });
  assert.deepEqual(plan.inputs.at(-1), { path: 'asset:text1', loopImage: true, imageDuration: 2 });
  assert.match(plan.filterComplex, /overlay=0:0:enable='between\(t,1\.0,3\.0\)'/);
  assert.match(plan.filterComplex, /\[base\]\[2:v\]overlay/);
  // 最后一级 overlay 输出无标签（ffmpeg 自动映射视频输出）
  assert.match(plan.filterComplex, /overlay=0:0:enable='between\(t,1\.0,3\.0\)'$/);
  // 音频轨片段 adelay 2000ms|2000ms + amix（主轨 concat + 延迟轨）
  assert.match(plan.filterComplex, /adelay=2000\|2000/);
  assert.match(plan.filterComplex, /amix=inputs=2:duration=longest:dropout_transition=0:normalize=0\[amixed\]/);
  assert.match(plan.filterComplex, /\[amixed\]atrim=end=6\.0,asetpts=PTS-STARTPTS;/);
});

test('空时间线 / 缺素材 → PlanError', () => {
  assert.throws(() => buildRenderPlan({ project: projectWith([]), asset: () => undefined, textAsset: () => undefined }), PlanError);
  assert.throws(
    () => buildRenderPlan({ project: projectWith([clipWith({ assetId: 'gone' })]), asset: () => undefined, textAsset: () => undefined }),
    PlanError,
  );
});
