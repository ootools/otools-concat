/** 编辑器中央状态：工程（reactive）+ 历史 + sidecar 客户端 + 播放/导出动作。 */
import { computed, reactive, ref } from 'vue';
import { t } from '../i18n.ts';
import {
  DEFAULT_TEXT_STYLE,
  emptyProject,
  projectDuration,
  type Clip,
  type ConcatProject,
  type RegisteredAsset,
} from '../types.ts';
import { appendAsset, nextId, placeClip, removeClipAndClose, splitClip, trackKind } from '../domain/project.ts';
import { createHistory, type History } from '../domain/history.ts';
import { createHostAdapter, type HostAdapter } from '../host/adapter.ts';
import {
  ConcatdClient,
  createReadyClient,
  ConcatdError,
  base64ToBytes,
  bytesToBase64,
  type ProbeResponse,
} from '../host/service.ts';
import { buildRenderPlan } from '../render/plan.ts';
import { encodeQoi } from '../render/qoi.ts';

export const adapter: HostAdapter = createHostAdapter();

export const project = reactive<ConcatProject>(emptyProject());

export const selection = ref<string | null>(null);
export const playhead = ref(0);
export const playing = ref(false);

export const serviceState = ref<'connecting' | 'ready' | 'error'>('connecting');
export const serviceError = ref<string | null>(null);
export const client = ref<ConcatdClient | null>(null);

export const importState = ref<'idle' | 'importing'>('idle');
export const exportState = ref<{ active: boolean; percent: number; message: string }>({
  active: false,
  percent: 0,
  message: '',
});
export const toast = ref<string | null>(null);

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function showToast(message: string): void {
  toast.value = message;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = null), 2600);
}

function snapshot(): ConcatProject {
  return JSON.parse(JSON.stringify(project)) as ConcatProject;
}

function applySnapshot(value: ConcatProject): void {
  Object.assign(project, value);
}

export const history: History<ConcatProject> = createHistory(snapshot, applySnapshot);

export const selectedClip = computed<Clip | null>(() => {
  if (!selection.value) return null;
  return project.clips.find((clip) => clip.id === selection.value) ?? null;
});

export const duration = computed(() => projectDuration(project));

export function assetById(assetId?: string): RegisteredAsset | undefined {
  if (!assetId) return undefined;
  return project.media.find((asset) => asset.id === assetId);
}

function commit(mutate: (draft: ConcatProject) => void): void {
  history.commit((current) => {
    const draft = JSON.parse(JSON.stringify(current)) as ConcatProject;
    mutate(draft);
    return draft;
  });
}

function mediaErrorMessage(error: unknown): string {
  if (error instanceof ConcatdError && (error.code === 'network' || error.code === 'startup')) return t('errorSidecar');
  return error instanceof Error ? error.message : String(error);
}

// —— 服务连接 ——

export async function connectService(): Promise<void> {
  serviceState.value = 'connecting';
  serviceError.value = null;
  try {
    const connection = await adapter.connect();
    client.value = await createReadyClient(connection);
    serviceState.value = 'ready';
  } catch (error) {
    client.value = null;
    serviceState.value = 'error';
    serviceError.value = mediaErrorMessage(error);
  }
}

// —— 导入 ——

export async function importPaths(paths: string[]): Promise<void> {
  if (!paths.length) return;
  if (!client.value) {
    showToast(t('errorSidecar'));
    return;
  }
  importState.value = 'importing';
  try {
    for (const path of paths) {
      const probe: ProbeResponse = await client.value.probe(path);
      if (project.media.some((asset) => asset.id === probe.mediaId)) continue;
      project.media.push({
        id: probe.mediaId,
        path,
        info: probe.info,
        previewMode: probe.previewMode,
        thumb: client.value.thumbUrl(probe.mediaId, Math.min(1, probe.info.duration / 3 || 0)),
      });
    }
  } catch (error) {
    const reason = mediaErrorMessage(error);
    showToast(t('importFailed', { reason }));
  } finally {
    importState.value = 'idle';
  }
}

export async function pickAndImport(): Promise<void> {
  const paths = await adapter.pickMedia();
  await importPaths(paths);
}

export function removeAsset(assetId: string): void {
  commit((draft) => {
    draft.media = draft.media.filter((asset) => asset.id !== assetId);
    draft.clips = draft.clips.filter((clip) => clip.assetId !== assetId);
  });
}

// —— 时间线操作 ——

export function addToTimeline(assetId: string): void {
  const asset = assetById(assetId);
  if (!asset) return;
  const trackId = asset.info.kind === 'audio' ? 'audio-1' : 'video-1';
  commit((draft) => {
    const clip = appendAsset(draft, asset, trackId);
    if (clip) draft.clips.push(clip);
  });
  if (project.clips.length) selection.value = project.clips[project.clips.length - 1]?.id ?? null;
}

export function addTextClip(): void {
  const start = playhead.value;
  commit((draft) => {
    draft.clips.push({
      id: nextId('clip'),
      trackId: 'text-1',
      start,
      duration: 3,
      in: 0,
      out: 0,
      speed: 1,
      volume: 1,
      muted: false,
      text: { ...DEFAULT_TEXT_STYLE, content: '' },
    });
  });
  selection.value = project.clips[project.clips.length - 1]?.id ?? null;
}

export function splitAtPlayhead(): void {
  const clipId = selection.value;
  if (!clipId) return;
  const result = splitClip(project, clipId, playhead.value);
  if (!result) return;
  commit((draft) => {
    const index = draft.clips.findIndex((clip) => clip.id === clipId);
    if (index < 0) return;
    draft.clips.splice(index, 1, result.before, result.after);
  });
  selection.value = result.after.id;
}

export function deleteSelected(): void {
  const clipId = selection.value;
  if (!clipId) return;
  commit((draft) => {
    Object.assign(draft, removeClipAndClose(draft, clipId));
  });
  selection.value = null;
}

export function moveClip(clipId: string, newStart: number): void {
  commit((draft) => {
    const clip = draft.clips.find((item) => item.id === clipId);
    if (!clip) return;
    const placed = placeClip(draft, clip.trackId, newStart, clip.duration);
    if (placed === null) return;
    clip.start = placed;
  });
}

export function trimClip(clipId: string, edge: 'start' | 'end', newSource: number): void {
  commit((draft) => {
    const clip = draft.clips.find((item) => item.id === clipId);
    if (!clip) return;
    const speed = clip.speed > 0 ? clip.speed : 1;
    if (edge === 'start') {
      const clamped = Math.min(Math.max(newSource, 0), clip.out - 0.1);
      const delta = (clamped - clip.in) / speed;
      if (clip.start + delta < 0) return;
      clip.in = clamped;
      clip.start += delta;
      clip.duration -= delta;
      // 主轨闭合：前移后与前面片段的缝隙保留（不强制吸附），但不得重叠。
      const siblings = draft.clips.filter((item) => item.trackId === clip.trackId && item.id !== clip.id && item.start < clip.start);
      const previousEnd = siblings.reduce((end, item) => Math.max(end, item.start + item.duration), 0);
      if (clip.start < previousEnd - 0.001) {
        const shift = previousEnd - clip.start;
        clip.start = previousEnd;
        clip.in += shift * speed;
        clip.duration -= shift;
      }
      if (clip.duration <= 0.1) return;
    } else {
      const clamped = Math.max(Math.min(newSource, clip.in + 3600), clip.in + 0.1);
      const asset = assetById(clip.assetId);
      const maxSource = asset && asset.info.kind !== 'image' ? asset.info.duration : clamped;
      clip.out = Math.min(clamped, maxSource);
      clip.duration = (clip.out - clip.in) / speed;
      // 与后续片段重叠则截断。
      const next = draft.clips
        .filter((item) => item.trackId === clip.trackId && item.id !== clip.id && item.start >= clip.start)
        .sort((a, b) => a.start - b.start)[0];
      if (next && clip.start + clip.duration > next.start + 0.001) {
        clip.duration = next.start - clip.start;
        clip.out = clip.in + clip.duration * speed;
      }
      if (clip.duration <= 0.1) return;
    }
  });
}

export function updateClip(clipId: string, mutate: (clip: Clip) => void): void {
  commit((draft) => {
    const clip = draft.clips.find((item) => item.id === clipId);
    if (clip) mutate(clip);
  });
}

export function newProject(): void {
  history.commit(() => emptyProject());
  applySnapshot(emptyProject());
  history.clear();
  selection.value = null;
  playhead.value = 0;
}

// —— 工程持久化 ——

export function serializeProject(): Uint8Array {
  const payload = { ...snapshot(), updatedAt: new Date().toISOString() };
  return new TextEncoder().encode(JSON.stringify(payload, null, 2));
}

export async function saveProjectAs(): Promise<void> {
  if (!client.value) {
    showToast(t('errorSidecar'));
    return;
  }
  const path = await adapter.saveProjectPath(project.name || 'project');
  if (!path) return;
  try {
    await client.value.saveProject(path, bytesToBase64(serializeProject()));
    project.name = path.split('/').pop()?.replace(/\.concatproj$/i, '') || project.name;
    showToast(t('saved'));
  } catch (error) {
    showToast(t('errorSaveProject', { reason: error instanceof Error ? error.message : String(error) }));
  }
}

export async function openProject(): Promise<void> {
  if (!client.value) {
    showToast(t('errorSidecar'));
    return;
  }
  const path = await adapter.pickProject();
  if (!path) return;
  try {
    const { dataBase64 } = await client.value.readProject(path);
    const parsed = JSON.parse(new TextDecoder().decode(base64ToBytes(dataBase64))) as ConcatProject;
    if (parsed?.version !== 1 || !Array.isArray(parsed.clips) || !Array.isArray(parsed.tracks)) {
      throw new Error('invalid');
    }
    history.commit(() => parsed);
    applySnapshot(parsed);
    history.clear();
    selection.value = null;
    playhead.value = 0;
    // 重新探针媒体（路径可能已移动；失败则保留条目但标记不可用）。
    for (const asset of project.media) {
      try {
        const probe = await client.value.probe(asset.path);
        if (probe.mediaId !== asset.id) {
          asset.id = probe.mediaId;
          asset.previewMode = probe.previewMode;
          asset.info = probe.info;
          asset.thumb = client.value.thumbUrl(probe.mediaId, 0);
          for (const clip of project.clips) if (clip.assetId) {
            const match = parsed.media.find((item) => item.id === clip.assetId);
            if (match && match.path === asset.path) clip.assetId = probe.mediaId;
          }
        }
      } catch {
        /* 媒体缺失：保留条目，播放/导出时报错 */
      }
    }
  } catch (error) {
    const message = error instanceof Error && error.message === 'invalid' ? '' : mediaErrorMessage(error);
    showToast(message ? t('errorOpenProject', { reason: message }) : t('errorInvalidProject'));
  }
}

// —— 文字覆盖层渲染（QOI：自带 ffmpeg 运行时无 zlib/PNG，QOI 为内建无损 RGBA） ——

export async function renderTextImage(clip: Clip, width: number, height: number): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas unavailable');
  const style = clip.text!;
  const fontPx = Math.round((style.fontSize / 1080) * height);
  context.font = `${style.italic ? 'italic ' : ''}${style.bold ? '700' : '400'} ${fontPx}px -apple-system, 'PingFang SC', 'Segoe UI', 'Noto Sans', 'Noto Sans Arabic', sans-serif`;
  context.textAlign = style.align === 'left' ? 'left' : style.align === 'right' ? 'right' : 'center';
  context.textBaseline = 'middle';
  const x = style.x * width;
  const y = style.y * height;
  const lines = style.content.split('\n');
  const lineHeight = fontPx * 1.3;
  lines.forEach((line, index) => {
    const lineY = y + (index - (lines.length - 1) / 2) * lineHeight;
    if (style.strokeWidth > 0) {
      context.strokeStyle = style.strokeColor;
      context.lineWidth = (style.strokeWidth / 1080) * height;
      context.lineJoin = 'round';
      context.strokeText(line, x, lineY);
    }
    context.fillStyle = style.color;
    context.fillText(line, x, lineY);
  });
  const imageData = context.getImageData(0, 0, width, height);
  return encodeQoi({ width, height, pixels: new Uint8Array(imageData.data) });
}

// —— 导出 ——

export async function startExport(outputPath: string): Promise<void> {
  const currentClient = client.value;
  if (!currentClient) throw new Error(t('errorSidecar'));
  if (duration.value <= 0) throw new Error(t('exportNoClips'));
  exportState.value = { active: true, percent: 0, message: '' };
  try {
    // 1) 文字片段 → 全画幅 PNG 上传
    const textRefs = new Map<string, string>();
    for (const clip of project.clips) {
      if (!clip.text || !clip.text.content.trim()) continue;
      const overlay = await renderTextImage(clip, project.meta.resolution.width, project.meta.resolution.height);
      const { assetId } = await currentClient.uploadText(bytesToBase64(overlay));
      textRefs.set(clip.id, assetId);
    }
    // 2) 编译渲染计划
    const plan = buildRenderPlan({
      project,
      asset: (assetId) => assetById(assetId),
      textAsset: (clipId) => {
        const assetId = textRefs.get(clipId);
        return assetId ? `asset:${assetId}` : undefined;
      },
    });
    // 3) 提交渲染任务 + SSE 进度
    const { renderId } = await currentClient.render({
      inputs: plan.inputs,
      filterComplex: plan.filterComplex,
      expectedDuration: plan.expectedDuration,
      output: outputPath,
      quality: plan.quality,
      hasAudio: plan.hasAudio,
    });
    await new Promise<void>((resolve, reject) => {
      const source = new EventSource(currentClient.renderEventsUrl(renderId));
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        source.close();
        error ? reject(error) : resolve();
      };
      source.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as { state?: string; percent?: number; message?: string };
          if (payload.state === 'running') {
            exportState.value.percent = payload.percent ?? 0;
          } else if (payload.state === 'done') {
            exportState.value.percent = 100;
            finish();
          } else if (payload.state === 'failed') {
            finish(new Error(payload.message || 'ffmpeg failed'));
          } else if (payload.state === 'cancelled') {
            finish(new Error('cancelled'));
          }
        } catch {
          /* 忽略坏帧 */
        }
      };
      source.onerror = () => {
        // SSE 断开后轮询兜底（服务可能在 done 后关闭流）。
        if (settled) return;
        void currentClient
          .renderStatus(renderId)
          .then((status) => {
            if (status.state === 'done') {
              exportState.value.percent = 100;
              finish();
            } else if (status.state === 'failed') {
              finish(new Error('ffmpeg failed'));
            } else if (status.state === 'cancelled') {
              finish(new Error('cancelled'));
            } else {
              finish(new Error('progress stream lost'));
            }
          })
          .catch(() => finish(new Error('progress stream lost')));
      };
    });
    exportState.value.message = t('exportDone');
  } catch (error) {
    const message = mediaErrorMessage(error);
    exportState.value.message = message === 'cancelled' ? t('exportCancelled') : t('exportFailed', { reason: message });
    throw error;
  } finally {
    exportState.value = { ...exportState.value, active: false };
  }
}

export { trackKind };
