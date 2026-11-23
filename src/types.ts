/** 共享类型：sidecar 返回的媒体信息 + 工程文档模型。 */

/** concatd /api/probe 返回的媒体元数据（camelCase）。 */
export interface MediaInfo {
  name: string;
  duration: number;
  kind: 'video' | 'audio' | 'image';
  videoCodec?: string;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio: boolean;
  audioTracks: { id: number; label: string; codec: string; language?: string }[];
}

export interface RegisteredAsset {
  id: string;
  path: string;
  info: MediaInfo;
  previewMode: 'browser' | 'remux' | 'proxy';
  /** UI 显示用的缩略图 URL（加载成功后有值）。 */
  thumb?: string;
  /** 波形峰值（音频素材，懒加载）。 */
  peaks?: number[];
}

/** 片段滤镜（eq 三参数，1 为原样；brightness 显示值 1 = eq 0）。 */
export interface ClipFilter {
  brightness: number;
  contrast: number;
  saturation: number;
}

export interface TextStyle {
  content: string;
  fontSize: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  /** 0..1 相对预览画布的锚点。 */
  x: number;
  y: number;
}

export type TrackKind = 'video' | 'audio' | 'text';

export interface Clip {
  id: string;
  trackId: string;
  assetId?: string;
  /** 时间线起点（秒）。 */
  start: number;
  /** 时间线时长（秒）= (out - in) / speed。 */
  duration: number;
  /** 源内区间（秒）。 */
  in: number;
  out: number;
  speed: number;
  volume: number;
  muted: boolean;
  filter?: ClipFilter;
  text?: TextStyle;
}

export interface Track {
  id: string;
  kind: TrackKind;
  name?: string;
}

export interface ProjectMeta {
  resolution: { width: number; height: number };
  fps: number;
  quality: 'high' | 'medium' | 'low';
}

export interface ConcatProject {
  version: 1;
  name: string;
  meta: ProjectMeta;
  media: RegisteredAsset[];
  tracks: Track[];
  clips: Clip[];
  updatedAt?: string;
}

export const FILTER_PRESETS: Record<string, ClipFilter | undefined> = {
  none: undefined,
  warm: { brightness: 1.04, contrast: 1.02, saturation: 1.22 },
  cool: { brightness: 0.99, contrast: 1.06, saturation: 0.88 },
  vivid: { brightness: 1.02, contrast: 1.12, saturation: 1.45 },
  mono: { brightness: 1.0, contrast: 1.05, saturation: 0 },
  fade: { brightness: 1.06, contrast: 0.88, saturation: 0.72 },
};

export const DEFAULT_TEXT_STYLE: TextStyle = {
  content: '',
  fontSize: 64,
  color: '#ffffff',
  strokeColor: '#000000',
  strokeWidth: 0,
  bold: true,
  italic: false,
  align: 'center',
  x: 0.5,
  y: 0.85,
};

export function emptyProject(): ConcatProject {
  return {
    version: 1,
    name: 'Untitled',
    meta: { resolution: { width: 1920, height: 1080 }, fps: 30, quality: 'medium' },
    media: [],
    tracks: [
      { id: 'text-1', kind: 'text' },
      { id: 'video-1', kind: 'video' },
      { id: 'audio-1', kind: 'audio' },
    ],
    clips: [],
  };
}

export function projectDuration(project: ConcatProject): number {
  return project.clips.reduce((max, clip) => Math.max(max, clip.start + clip.duration), 0);
}
