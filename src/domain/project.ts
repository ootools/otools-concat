/** 工程文档的纯函数操作（可单测，不依赖 Vue）。 */
import type { Clip, ConcatProject, RegisteredAsset, TrackKind } from '../types.ts';

let counter = 0;
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/** 源区间长度换算成时间线时长（考虑变速）。 */
export function sourceSpan(clip: Clip): number {
  return Math.max(0, clip.out - clip.in);
}

export function clipDurationFromSource(clip: Pick<Clip, 'in' | 'out' | 'speed'>): number {
  const speed = clip.speed > 0 ? clip.speed : 1;
  return Math.max(0, (clip.out - clip.in) / speed);
}

/** 主轨（video）内按 start 排序的片段。 */
export function clipsOnTrack(project: ConcatProject, trackId: string): Clip[] {
  return project.clips
    .filter((clip) => clip.trackId === trackId)
    .sort((a, b) => a.start - b.start);
}

export function trackKind(project: ConcatProject, trackId: string): TrackKind | undefined {
  return project.tracks.find((track) => track.id === trackId)?.kind;
}

/**
 * 在轨道的指定时间点放置片段：默认吸附到已有片段边缘（无缝追加行为）。
 * 撞车时返回 null（调用方决定提示）。图片时长由调用方给定。
 */
export function placeClip(
  project: ConcatProject,
  trackId: string,
  desiredStart: number,
  duration: number,
): number | null {
  const kind = trackKind(project, trackId);
  const siblings = clipsOnTrack(project, trackId);
  if (kind === 'video' || kind === 'audio') {
    // 线性主/音频轨：不允许重叠，吸附到相邻片段边界。
    let start = Math.max(0, desiredStart);
    for (const other of siblings) {
      const otherEnd = other.start + other.duration;
      const overlaps = start < otherEnd - 0.001 && start + duration > other.start + 0.001;
      if (!overlaps) continue;
      // 尝试贴到该片段右侧（追加语义）。
      start = otherEnd;
      // 贴完仍与后续片段重叠则失败。
      const next = siblings.find((item) => item !== other && item.start < start + duration - 0.001 && item.start + item.duration > start + 0.001);
      if (next) return null;
    }
    return start;
  }
  // 文字轨允许重叠（多字幕并存）。
  return Math.max(0, desiredStart);
}

/** 在时间点 t 处把片段一分为二；t 必须落在片段内部（含 5ms 容差）。 */
export function splitClip(project: ConcatProject, clipId: string, t: number): { before: Clip; after: Clip } | null {
  const clip = project.clips.find((item) => item.id === clipId);
  if (!clip) return null;
  const local = t - clip.start;
  if (local <= 0.05 || local >= clip.duration - 0.05) return null;
  const speed = clip.speed > 0 ? clip.speed : 1;
  const cutSource = clip.in + local * speed;
  const before: Clip = { ...clip, out: cutSource, duration: local };
  const after: Clip = {
    ...clip,
    id: nextId('clip'),
    start: clip.start + local,
    in: cutSource,
    duration: clip.duration - local,
  };
  return { before, after };
}

export function removeClip(project: ConcatProject, clipId: string): ConcatProject {
  return { ...project, clips: project.clips.filter((clip) => clip.id !== clipId) };
}

/** 删除片段后同轨后续片段左移补位（主轨/音频轨的闭合行为）。 */
export function removeClipAndClose(project: ConcatProject, clipId: string): ConcatProject {
  const clip = project.clips.find((item) => item.id === clipId);
  const clips = project.clips.filter((item) => item.id !== clipId);
  if (clip && (trackKind(project, clip.trackId) === 'video' || trackKind(project, clip.trackId) === 'audio')) {
    for (const other of clips) {
      if (other.trackId === clip.trackId && other.start > clip.start - 0.001) {
        other.start = Math.max(0, other.start - clip.duration);
      }
    }
  }
  return { ...project, clips };
}

/** 把素材追加到主轨末尾（媒体库「添加到时间线」的默认行为）。 */
export function appendAsset(project: ConcatProject, asset: RegisteredAsset, trackId: string, imageDuration = 4): Clip | null {
  const kind = trackKind(project, trackId);
  const mediaKind = asset.info.kind;
  if (kind === 'video' && mediaKind !== 'video' && mediaKind !== 'image') return null;
  if (kind === 'audio' && mediaKind !== 'audio') return null;
  const siblings = clipsOnTrack(project, trackId);
  const start = siblings.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);
  const sourceDuration = mediaKind === 'image' ? imageDuration : Math.max(0.1, asset.info.duration);
  const clip: Clip = {
    id: nextId('clip'),
    trackId,
    assetId: asset.id,
    start,
    duration: sourceDuration,
    in: 0,
    out: mediaKind === 'image' ? 0 : sourceDuration,
    speed: 1,
    volume: 1,
    muted: false,
  };
  return clip;
}

export function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const total = Math.floor(safe);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  const cs = Math.floor((safe - total) * 100);
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
