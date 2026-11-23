/** 工程模型纯函数单测（node --test --experimental-strip-types）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendAsset,
  clipDurationFromSource,
  clipsOnTrack,
  formatTime,
  nextId,
  placeClip,
  removeClipAndClose,
  splitClip,
} from './project.ts';
import { emptyProject, type Clip, type RegisteredAsset } from '../types.ts';

function videoAsset(id: string, duration = 10): RegisteredAsset {
  return {
    id,
    path: `/tmp/${id}.mp4`,
    previewMode: 'browser',
    info: { name: `${id}.mp4`, duration, kind: 'video', videoCodec: 'h264', width: 640, height: 360, hasAudio: true, audioTracks: [{ id: 0, label: 'a', codec: 'aac' }] },
  };
}

function baseClip(partial: Partial<Clip> = {}): Clip {
  return {
    id: partial.id ?? nextId('clip'),
    trackId: partial.trackId ?? 'video-1',
    assetId: partial.assetId ?? 'm1',
    start: partial.start ?? 0,
    duration: partial.duration ?? 4,
    in: partial.in ?? 0,
    out: partial.out ?? 4,
    speed: partial.speed ?? 1,
    volume: partial.volume ?? 1,
    muted: partial.muted ?? false,
  };
}

test('placeClip：主轨无缝吸附到已有片段右侧', () => {
  const project = emptyProject();
  project.clips = [baseClip({ start: 0, duration: 4 })];
  assert.equal(placeClip(project, 'video-1', 1, 3), 4); // 撞车 → 贴右侧
  assert.equal(placeClip(project, 'video-1', 10, 3), 10); // 空闲位置原样
  assert.equal(placeClip(project, 'text-1', 1, 3), 1); // 文字轨允许重叠
});

test('splitClip：命中内部时间点切两半，越界返回 null', () => {
  const project = emptyProject();
  project.clips = [baseClip({ start: 2, duration: 6, in: 1, out: 7 })];
  const result = splitClip(project, project.clips[0].id, 5);
  assert.ok(result);
  assert.equal(result.before.duration, 3);
  assert.equal(result.before.out, 4);
  assert.equal(result.after.start, 5);
  assert.equal(result.after.in, 4);
  assert.equal(result.after.duration, 3);
  assert.equal(splitClip(project, project.clips[0].id, 1.5), null);
  assert.equal(splitClip(project, project.clips[0].id, 8), null);
});

test('removeClipAndClose：主轨后续片段左移补位', () => {
  const project = emptyProject();
  const first = baseClip({ id: 'a', start: 0, duration: 4 });
  const second = baseClip({ id: 'b', start: 4, duration: 4 });
  project.clips = [first, second];
  const next = removeClipAndClose(project, 'a');
  assert.equal(next.clips.length, 1);
  assert.equal(next.clips[0].id, 'b');
  assert.equal(next.clips[0].start, 0);
});

test('appendAsset：追加到主轨末尾', () => {
  const project = emptyProject();
  project.clips = [baseClip({ start: 0, duration: 4 })];
  const clip = appendAsset(project, videoAsset('m2'), 'video-1');
  assert.ok(clip);
  assert.equal(clip.start, 4);
  assert.equal(clip.duration, 10);
});

test('clipDurationFromSource 与 formatTime', () => {
  assert.equal(clipDurationFromSource({ in: 1, out: 5, speed: 2 }), 2);
  assert.equal(clipDurationFromSource({ in: 0, out: 4, speed: 0.5 }), 8);
  assert.equal(formatTime(65.4), '01:05.40');
  assert.equal(formatTime(0), '00:00.00');
});

test('clipsOnTrack 按 start 排序', () => {
  const project = emptyProject();
  project.clips = [baseClip({ id: 'b', start: 6 }), baseClip({ id: 'a', start: 1 })];
  assert.deepEqual(clipsOnTrack(project, 'video-1').map((clip) => clip.id), ['a', 'b']);
});
