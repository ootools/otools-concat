/**
 * 工程文档 → ffmpeg 渲染计划（纯函数，可单测）。
 * ------------------------------------------------------------------
 * 服务端只做 argv 组装与进程管理；filter_complex 图完全在这里编译：
 *   - 主轨（video/image）逐片段 trim+变速+eq+统一尺寸/fps → concat；
 *   - 音频 = 主轨各片段音链 concat ⊕ 音频轨 adelay 后 amix（无音频源则省略）；
 *   - 文字片段 = 前端 canvas 渲染的全画幅透明 PNG，overlay + enable 窗口。
 * 变速：视频 setpts=(PTS-STARTPTS)/speed；音频 atempo 链（每段 0.5..2）。
 */
import type { Clip, ConcatProject, RegisteredAsset } from '../types.ts';
import { clipsOnTrack } from '../domain/project.ts';

export interface RenderInputSpec {
  /** 本地媒体绝对路径，或 "asset:<id>"（sidecar 内注册的文字 PNG）。 */
  path?: string;
  /** lavfi 合成源（anullsrc 静音等），与 path 互斥。 */
  lavfi?: string;
  /** 静态图循环为视频流。 */
  loopImage?: boolean;
  imageDuration?: number;
  /** lavfi / 循环图时长。 */
  duration?: number;
}

export interface RenderPlan {
  inputs: RenderInputSpec[];
  filterComplex: string;
  expectedDuration: number;
  hasAudio: boolean;
  quality: 'high' | 'medium' | 'low';
}

export class PlanError extends Error {}

const AUDIO_RATE = 48000;

/** atempo 每实例只支持 0.5..2，超出拆链。 */
export function atempoChain(speed: number): string[] {
  const chain: string[] = [];
  let rest = speed;
  while (rest >= 2.0) {
    chain.push('atempo=2.0');
    rest /= 2.0;
  }
  while (rest <= 0.5) {
    chain.push('atempo=0.5');
    rest *= 2.0;
  }
  // 循环后 rest 是剩余倍率：≠1 时补一段收尾；原速（speed=1）返回空链（无滤镜）。
  if (Math.abs(rest - 1) > 1e-9) chain.push(`atempo=${rest.toFixed(4)}`);
  return chain;
}

function eqFilter(clip: Clip): string | null {
  const filter = clip.filter;
  if (!filter) return null;
  const parts: string[] = [];
  const brightness = Number((filter.brightness - 1).toFixed(3));
  const contrast = Number(filter.contrast.toFixed(3));
  const saturation = Number(filter.saturation.toFixed(3));
  if (brightness !== 0) parts.push(`brightness=${brightness}`);
  if (contrast !== 1) parts.push(`contrast=${contrast}`);
  if (saturation !== 1) parts.push(`saturation=${saturation}`);
  return parts.length ? `eq=${parts.join(':')}` : null;
}

function filterCss(clip: Clip): string {
  const filter = clip.filter;
  if (!filter) return '';
  return `brightness(${filter.brightness}) contrast(${filter.contrast}) saturate(${filter.saturation})`;
}

export { filterCss };

function num(value: number): string {
  // ffmpeg 时间/参数用定点小数（避免科学计数法）。
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0');
}

export interface PlanContext {
  project: ConcatProject;
  /** assetId → 已注册素材（含路径）。 */
  asset: (assetId: string) => RegisteredAsset | undefined;
  /** textClipId → 已上传文字 PNG 的 "asset:<id>" 引用。 */
  textAsset: (clipId: string) => string | undefined;
}

export function buildRenderPlan(context: PlanContext): RenderPlan {
  const { project, asset, textAsset } = context;
  const { width, height } = project.meta.resolution;
  const fps = project.meta.fps || 30;
  const videoTrack = project.tracks.find((track) => track.kind === 'video');
  const audioTrackIds = project.tracks.filter((track) => track.kind === 'audio').map((track) => track.id);
  const textTrackIds = project.tracks.filter((track) => track.kind === 'text').map((track) => track.id);
  if (!videoTrack) throw new PlanError('no video track');
  const videoClips = clipsOnTrack(project, videoTrack.id);
  if (!videoClips.length) throw new PlanError('timeline is empty');

  const inputs: RenderInputSpec[] = [];
  const videoChains: string[] = [];
  const videoLabels: string[] = [];
  const audioChains: string[] = [];
  let hasAudio = false;

  // —— 主轨：逐片段输入 + 视频/音频链 ——
  for (const clip of videoClips) {
    const index = inputs.length;
    const assetInfo = clip.assetId ? asset(clip.assetId) : undefined;
    if (!assetInfo) throw new PlanError('missing asset for clip');
    if (assetInfo.info.kind === 'image') {
      inputs.push({ path: assetInfo.path, loopImage: true, imageDuration: clip.duration });
      videoChains.push(
        `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${index}]`,
      );
      videoLabels.push(`[v${index}]`);
    } else {
      inputs.push({ path: assetInfo.path });
      const speed = clip.speed > 0 ? clip.speed : 1;
      const chainParts = [
        `trim=start=${num(clip.in)}:end=${num(clip.out)}`,
        `setpts=(PTS-STARTPTS)/${num(speed)}`,
      ];
      const eq = eqFilter(clip);
      if (eq) chainParts.push(eq);
      chainParts.push(
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
        'setsar=1',
        `fps=${fps}`,
        'format=yuv420p',
      );
      videoChains.push(`[${index}:v]${chainParts.join(',')}[v${index}]`);
      videoLabels.push(`[v${index}]`);
      if (assetInfo.info.hasAudio && !clip.muted) {
        hasAudio = true;
        const audioParts = [`atrim=start=${num(clip.in)}:end=${num(clip.out)}`, 'asetpts=PTS-STARTPTS'];
        audioParts.push(...atempoChain(speed));
        if (clip.volume !== 1) audioParts.push(`volume=${num(clip.volume)}`);
        audioParts.push(`aformat=sample_rates=${AUDIO_RATE}:channel_layouts=stereo`);
        audioChains.push(`[${index}:a]${audioParts.join(',')}[a${index}]`);
      } else {
        // 无声片段补静音，保证音频 concat 位数一致。
        inputs.push({ lavfi: `anullsrc=r=${AUDIO_RATE}:cl=stereo`, duration: clip.duration });
        audioChains.push(`[${inputs.length - 1}:a]anull[a${inputs.length - 1}]`);
      }
    }
  }

  const mainDuration = videoClips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);

  // —— 主轨视频 concat ——
  const baseParts: string[] = [...videoChains];
  let baseLabel = 'base';
  if (videoLabels.length === 1) {
    baseParts.push(`${videoLabels[0]}null[${baseLabel}]`);
  } else {
    baseParts.push(`${videoLabels.join('')}concat=n=${videoLabels.length}:v=1:a=0[${baseLabel}]`);
  }

  // —— 主轨音频 concat ——
  let mainAudioLabel: string | null = null;
  if (audioChains.length === 1) {
    mainAudioLabel = audioChains[0].match(/\[(a\d+)\]$/)?.[1] ?? null;
    if (mainAudioLabel) baseParts.push(audioChains[0]);
  } else if (audioChains.length > 1) {
    const audioLabels = audioChains.map((chain) => chain.match(/\[(a\d+)\]$/)?.[1] ?? '');
    baseParts.push(...audioChains);
    baseParts.push(
      `${audioLabels.map((label) => `[${label}]`).join('')}concat=n=${audioLabels.length}:v=0:a=1[amain]`,
    );
    mainAudioLabel = 'amain';
  }

  // —— 音频轨（绝对时间 adelay）——
  const mixLabels: string[] = [];
  if (mainAudioLabel) mixLabels.push(`[${mainAudioLabel}]`);
  for (const trackId of audioTrackIds) {
    for (const clip of clipsOnTrack(project, trackId)) {
      const assetInfo = clip.assetId ? asset(clip.assetId) : undefined;
      if (!assetInfo) throw new PlanError('missing asset for clip');
      if (assetInfo.info.kind !== 'audio' && !assetInfo.info.hasAudio) continue;
      const index = inputs.length;
      inputs.push({ path: assetInfo.path });
      hasAudio = true;
      const parts = [`atrim=start=${num(clip.in)}:end=${num(clip.out)}`, 'asetpts=PTS-STARTPTS'];
      parts.push(...atempoChain(clip.speed > 0 ? clip.speed : 1));
      if (clip.volume !== 1) parts.push(`volume=${num(clip.volume)}`);
      parts.push(`aformat=sample_rates=${AUDIO_RATE}:channel_layouts=stereo`);
      const delayMs = Math.max(0, Math.round(clip.start * 1000));
      parts.push(`adelay=${delayMs}|${delayMs}`);
      parts.push('anull');
      const label = `ad${index}`;
      baseParts.push(`[${index}:a]${parts.join(',')}[${label}]`);
      mixLabels.push(`[${label}]`);
    }
  }

  // —— 混音 ——
  // ffmpeg 只自动映射「未打标签」的 filter 输出，所以最终音频链必须去掉尾部标签：
  //   单音源 → 该链本身作为输出；多音源 → amix+atrim 收尾，输出不带标签。
  if (hasAudio && mixLabels.length === 1) {
    const only = baseParts.findIndex((part) => part.endsWith(mixLabels[0]));
    if (only >= 0) baseParts[only] = baseParts[only].slice(0, -mixLabels[0].length);
  } else if (hasAudio) {
    baseParts.push(
      `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0:normalize=0[amixed]`,
    );
    baseParts.push(`[amixed]atrim=end=${num(mainDuration)},asetpts=PTS-STARTPTS`);
  }

  // —— 文字 overlay（PNG 全画幅，enable 时间窗）——
  // 链式串联；除最后一级外挂 [oN] 标签，最后一级输出不打标签（ffmpeg 自动映射视频输出）。
  const overlayParts: string[] = [];
  for (const trackId of textTrackIds) {
    for (const clip of clipsOnTrack(project, trackId)) {
      const reference = textAsset(clip.id);
      if (!reference || !clip.text || !clip.text.content.trim()) continue;
      const index = inputs.length;
      inputs.push({ path: reference, loopImage: true, imageDuration: clip.duration });
      const end = clip.start + clip.duration;
      const inputLabel = overlayParts.length === 0 ? baseLabel : `o${overlayParts.length - 1}`;
      overlayParts.push(
        `[${inputLabel}][${index}:v]overlay=0:0:enable='between(t,${num(clip.start)},${num(end)})'`,
      );
    }
  }
  overlayParts.forEach((part, position) => {
    baseParts.push(position < overlayParts.length - 1 ? `${part}[o${position}]` : part);
  });
  if (!overlayParts.length) {
    baseParts.push(`[${baseLabel}]null`);
  }

  const filterComplex = baseParts.join(';');
  return {
    inputs,
    filterComplex,
    expectedDuration: mainDuration,
    hasAudio,
    quality: project.meta.quality,
  };
}
