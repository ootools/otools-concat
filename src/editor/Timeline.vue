<script setup lang="ts">
import { computed, ref } from 'vue';
import { t } from '../i18n';
import {
  client,
  duration,
  assetById,
  moveClip,
  playhead,
  project,
  selection,
  trimClip,
  addTextClip,
} from './store';
import { clipsOnTrack, formatTime } from '../domain/project';
import type { Clip } from '../types';

const pxPerSecond = ref(48);
const zoomLevels = [12, 24, 48, 96, 192];
const zoomIndex = ref(2);
const scrollEl = ref<HTMLElement | null>(null);

function setZoom(delta: number) {
  zoomIndex.value = Math.max(0, Math.min(zoomLevels.length - 1, zoomIndex.value + delta));
  pxPerSecond.value = zoomLevels[zoomIndex.value];
}

function zoomFit() {
  const width = (scrollEl.value?.clientWidth ?? 900) - 90;
  pxPerSecond.value = Math.max(6, width / Math.max(duration.value, 1));
}

const totalWidth = computed(() => Math.max(duration.value + 4, 16) * pxPerSecond.value + 60);

const ticks = computed(() => {
  const stepCandidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = stepCandidates.find((value) => value * pxPerSecond.value >= 64) ?? 600;
  const result: { time: number; label: string }[] = [];
  for (let time = 0; time <= totalWidth.value / pxPerSecond.value; time += step) {
    result.push({ time, label: formatTime(time).slice(0, 5) });
  }
  return result;
});

function laneTime(event: PointerEvent | MouseEvent): number {
  const lane = (event.currentTarget as HTMLElement).closest('.timeline-scroll') as HTMLElement | null;
  const inner = lane?.querySelector('.timeline-inner') as HTMLElement | null;
  if (!inner) return 0;
  const rect = inner.getBoundingClientRect();
  return Math.max(0, (event.clientX - rect.left) / pxPerSecond.value);
}

function onRulerPointer(event: PointerEvent) {
  playhead.value = Math.min(duration.value, laneTime(event));
  const move = (moveEvent: PointerEvent) => {
    playhead.value = Math.min(duration.value, Math.max(0, laneTimeFor(moveEvent)));
  };
  const lane = (event.currentTarget as HTMLElement).closest('.timeline-scroll') as HTMLElement;
  const inner = lane.querySelector('.timeline-inner') as HTMLElement;
  const laneTimeFor = (e: PointerEvent) => Math.max(0, (e.clientX - inner.getBoundingClientRect().left) / pxPerSecond.value);
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// —— 片段拖动 / 裁剪 ——

interface DragState {
  mode: 'move' | 'trim-start' | 'trim-end';
  clip: Clip;
  grabOffset: number;
  startClientX: number;
}

let drag: DragState | null = null;

function snapTime(time: number, excludeClipId?: string): number {
  const threshold = 8 / pxPerSecond.value;
  const edges = [0, playhead.value];
  for (const clip of project.clips) {
    if (clip.id === excludeClipId) continue;
    edges.push(clip.start, clip.start + clip.duration);
  }
  let best = time;
  let bestDelta = threshold;
  for (const edge of edges) {
    const delta = Math.abs(time - edge);
    if (delta < bestDelta) {
      best = edge;
      bestDelta = delta;
    }
  }
  return Math.max(0, best);
}

function onClipPointerDown(event: PointerEvent, clip: Clip, mode: DragState['mode']) {
  event.stopPropagation();
  selection.value = clip.id;
  const laneRect = (event.currentTarget as HTMLElement).closest('.track-lane')?.getBoundingClientRect();
  drag = {
    mode,
    clip,
    grabOffset: mode === 'move' && laneRect ? (event.clientX - laneRect.left) / pxPerSecond.value - clip.start : 0,
    startClientX: event.clientX,
  };
  const move = (moveEvent: PointerEvent) => {
    if (!drag) return;
    const laneRectCurrent = (event.currentTarget as HTMLElement | null)?.closest?.('.track-lane')?.getBoundingClientRect();
    const rect = laneRectCurrent ?? laneRect;
    if (!rect) return;
    const deltaSeconds = (moveEvent.clientX - drag.startClientX) / pxPerSecond.value;
    if (drag.mode === 'move') {
      const desired = (moveEvent.clientX - rect.left) / pxPerSecond.value - drag.grabOffset;
      moveClip(drag.clip.id, snapTime(Math.max(0, desired), drag.clip.id));
    } else if (drag.mode === 'trim-start') {
      const newIn = Math.max(0, Math.min(clip.out - 0.1, clip.in + deltaSeconds * (clip.speed || 1)));
      trimClip(clip.id, 'start', newIn);
    } else {
      const newOut = Math.max(clip.in + 0.1, clip.out + deltaSeconds * (clip.speed || 1));
      trimClip(clip.id, 'end', newOut);
    }
  };
  const up = () => {
    drag = null;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function clipStyle(clip: Clip) {
  const left = clip.start * pxPerSecond.value;
  const width = Math.max(6, clip.duration * pxPerSecond.value);
  return { left: `${left}px`, width: `${width}px` };
}

function clipThumb(clip: Clip): string | undefined {
  const asset = assetById(clip.assetId);
  if (!client.value || !asset || asset.info.kind === 'audio') return undefined;
  if (asset.info.kind === 'image') return client.value.imageUrl(asset.id);
  return asset.thumb ?? client.value.thumbUrl(asset.id, clip.in);
}

function clipName(clip: Clip): string {
  if (clip.text?.content) return clip.text.content;
  return assetById(clip.assetId)?.info.name ?? '';
}

const audioTracks = computed(() => project.tracks.filter((track) => track.kind === 'audio'));
const textTracks = computed(() => project.tracks.filter((track) => track.kind === 'text'));
const videoTrackRef = computed(() => project.tracks.find((track) => track.kind === 'video'));

const trackMeta = computed(() => [
  ...(videoTrackRef.value ? [{ track: videoTrackRef.value, label: t('videoTrack'), kind: 'video' }] : []),
  ...audioTracks.value.map((track) => ({ track, label: t('audioTrack'), kind: 'audio' })),
  ...textTracks.value.map((track) => ({ track, label: t('textTrack'), kind: 'text' })),
]);

function clipsFor(trackId: string): Clip[] {
  return clipsOnTrack(project, trackId);
}

const playheadX = computed(() => `${playhead.value * pxPerSecond.value}px`);

async function drawWave(canvas: HTMLCanvasElement, clip: Clip) {
  const currentClient = client.value;
  const asset = assetById(clip.assetId);
  if (!currentClient || !asset) return;
  try {
    const { peaks } = await currentClient.peaks(asset.id);
    const context = canvas.getContext('2d');
    if (!context) return;
    const width = canvas.width;
    const height = canvas.height;
    context.clearRect(0, 0, width, height);
    context.fillStyle = 'rgba(255,255,255,0.85)';
    const sourceStart = Math.floor((clip.in / Math.max(asset.info.duration, 0.001)) * peaks.length);
    const sourceEnd = Math.ceil((clip.out / Math.max(asset.info.duration, 0.001)) * peaks.length);
    const slice = peaks.slice(sourceStart, Math.max(sourceEnd, sourceStart + 1));
    slice.forEach((value, index) => {
      const x = (index / slice.length) * width;
      const bar = Math.max(1, (value / 255) * height);
      context.fillRect(x, height - bar, Math.max(1, width / slice.length - 0.5), bar);
    });
  } catch {
    /* 无波形（音频解析失败）留空 */
  }
}

function onWaveMount(el: HTMLCanvasElement | null, clip: Clip) {
  if (!el) return;
  void drawWave(el, clip);
}
</script>

<template>
  <div class="timeline">
    <div class="timeline-toolbar">
      <button class="icon-only ghost" :title="t('zoomOut')" @click="setZoom(-1)">－</button>
      <button class="icon-only ghost" :title="t('zoomIn')" @click="setZoom(1)">＋</button>
      <button class="ghost" :title="t('zoomFit')" @click="zoomFit">{{ t('zoomFit') }}</button>
      <button class="ghost" @click="addTextClip">＋ {{ t('addTextClip') }}</button>
      <span style="flex: 1"></span>
      <span class="status" style="font-size: 11px; color: var(--cc-text-2)">{{ t('timePosition', { time: formatTime(playhead), total: formatTime(duration) }) }}</span>
    </div>
    <div ref="scrollEl" class="timeline-scroll" @pointerdown.self="playhead = laneTime($event)">
      <div class="timeline-inner" :style="{ width: `${totalWidth}px` }">
        <div class="ruler" @pointerdown.stop="onRulerPointer">
          <div v-for="tick in ticks" :key="tick.time" class="tick" :style="{ left: `${tick.time * pxPerSecond}px` }">
            {{ tick.label }}
          </div>
        </div>
        <div
          v-for="meta in trackMeta"
          :key="meta.track.id"
          class="track-row"
          :class="{ 'text-track': meta.kind === 'text' }"
        >
          <div class="track-label">{{ meta.label }}</div>
          <div class="track-lane" @pointerdown.self="playhead = Math.min(duration, laneTime($event))">
            <div
              v-for="clip in clipsFor(meta.track.id)"
              :key="clip.id"
              class="clip"
              :class="[meta.kind, { selected: selection === clip.id }]"
              :style="clipStyle(clip)"
              @pointerdown="onClipPointerDown($event, clip, 'move')"
            >
              <img v-if="meta.kind === 'video' && clipThumb(clip)" class="clip-thumb" :src="clipThumb(clip)" alt="" draggable="false" />
              <canvas
                v-if="meta.kind === 'audio'"
                class="wave"
                width="600"
                height="40"
                :ref="(el) => onWaveMount(el as HTMLCanvasElement | null, clip)"
              ></canvas>
              <span class="clip-name">{{ clipName(clip) }}</span>
              <div v-if="meta.kind !== 'text'" class="handle start" @pointerdown.stop="onClipPointerDown($event, clip, 'trim-start')"></div>
              <div v-if="meta.kind !== 'text'" class="handle end" @pointerdown.stop="onClipPointerDown($event, clip, 'trim-end')"></div>
            </div>
          </div>
        </div>
        <div class="playhead" :style="{ left: playheadX }"></div>
      </div>
    </div>
  </div>
</template>
