<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { t } from '../i18n';
import {
  client,
  duration,
  assetById,
  playhead,
  playing,
  project,
} from './store';
import { filterCss } from '../render/plan';
import { clipsOnTrack } from '../domain/project';
import { formatTime } from '../domain/project';
import type { Clip } from '../types';

const videoEl = ref<HTMLVideoElement | null>(null);

const videoTrack = computed(() => project.tracks.find((track) => track.kind === 'video'));
const videoClips = computed(() => (videoTrack.value ? clipsOnTrack(project, videoTrack.value.id) : []));

function clipAt(time: number): Clip | undefined {
  return videoClips.value.find((clip) => time >= clip.start - 0.001 && time < clip.start + clip.duration - 0.001);
}

const activeClip = ref<Clip | null>(null);
const activeAsset = computed(() => assetById(activeClip.value?.assetId));
const activeIsImage = computed(() => activeAsset.value?.info.kind === 'image');

const previewUrl = computed(() => {
  const asset = activeAsset.value;
  if (!client.value || !asset) return '';
  return asset.info.kind === 'image'
    ? client.value.imageUrl(asset.id)
    : client.value.previewUrl(asset.id);
});

const ratioStyle = computed(() => ({
  '--cc-preview-ratio': `${project.meta.resolution.width} / ${project.meta.resolution.height}`,
}));

const videoStyle = computed(() => {
  const filter = activeClip.value?.filter;
  return filter ? { filter: filterCss({ ...(activeClip.value as Clip), filter }) } : {};
});

const overlayTexts = computed(() => {
  return project.clips
    .filter(
      (clip) =>
        clip.text &&
        clip.text.content.trim() &&
        playhead.value >= clip.start - 0.001 &&
        playhead.value < clip.start + clip.duration,
    )
    .map((clip) => {
      const style = clip.text!;
      return {
        id: clip.id,
        content: style.content,
        style: {
          insetInlineStart: `${style.x * 100}%`,
          insetBlockStart: `${style.y * 100}%`,
          font: `${style.italic ? 'italic ' : ''}${style.bold ? '700' : '400'} ${style.fontSize}px -apple-system, 'PingFang SC', 'Segoe UI', 'Noto Sans', 'Noto Sans Arabic', sans-serif`,
          color: style.color,
          textAlign: style.align,
          transform: `translate(-50%, -50%)`,
          maxWidth: '92%',
          WebkitTextStroke: style.strokeWidth > 0 ? `${style.strokeWidth * 0.4}px ${style.strokeColor}` : undefined,
        },
      };
    });
});

// —— 音频池（音频轨片段逐元素同步） ——
const audioPool = new Map<string, HTMLAudioElement>();

function audioClipElements(): { clip: Clip; element: HTMLAudioElement }[] {
  const result: { clip: Clip; element: HTMLAudioElement }[] = [];
  if (!client.value) return result;
  for (const track of project.tracks.filter((item) => item.kind === 'audio')) {
    for (const clip of clipsOnTrack(project, track.id)) {
      const asset = assetById(clip.assetId);
      if (!asset || clip.muted) continue;
      let element = audioPool.get(clip.id);
      if (!element) {
        element = document.createElement('audio');
        element.preload = 'auto';
        element.src = client.value.previewUrl(asset.id);
        audioPool.set(clip.id, element);
      }
      result.push({ clip, element });
    }
  }
  return result;
}

function syncAudio(time: number, shouldPlay: boolean): void {
  for (const { clip, element } of audioClipElements()) {
    const local = (time - clip.start) * (clip.speed > 0 ? clip.speed : 1) + clip.in;
    const inside = time >= clip.start - 0.05 && time < clip.start + clip.duration;
    if (!inside) {
      if (!element.paused) element.pause();
      continue;
    }
    if (Math.abs(element.currentTime - local) > 0.25) element.currentTime = Math.max(0, local);
    element.volume = Math.max(0, Math.min(1, clip.volume));
    element.playbackRate = Math.max(0.25, Math.min(4, clip.speed || 1));
    if (shouldPlay && element.paused) void element.play().catch(() => {});
    if (!shouldPlay && !element.paused) element.pause();
  }
}

function releasePool(): void {
  for (const element of audioPool.values()) {
    element.pause();
    element.removeAttribute('src');
  }
  audioPool.clear();
}

// —— 主循环 ——
let raf = 0;
let lastWall = 0;
let switching = false;

function stopLoop(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

async function loadActive(time: number): Promise<void> {
  const clip = clipAt(time) ?? videoClips.value[videoClips.value.length - 1];
  if (!clip) {
    activeClip.value = null;
    return;
  }
  if (activeClip.value?.id !== clip.id || !videoEl.value?.src) {
    switching = true;
    activeClip.value = clip;
    await new Promise<void>((resolve) => {
      const el = videoEl.value;
      if (!el) return resolve();
      const done = () => {
        el.removeEventListener('loadedmetadata', done);
        resolve();
      };
      el.addEventListener('loadedmetadata', done);
      setTimeout(done, 3000);
    });
    switching = false;
  }
  const el = videoEl.value;
  if (!el || activeIsImage.value) return;
  const target = clip.in + (time - clip.start) * (clip.speed > 0 ? clip.speed : 1);
  const clamped = Math.max(0, Math.min(target, (clip.out || clip.in + clip.duration) - 0.05));
  if (Math.abs(el.currentTime - clamped) > 0.08) el.currentTime = clamped;
  el.playbackRate = Math.max(0.25, Math.min(4, clip.speed || 1));
  el.muted = clip.muted;
  el.volume = Math.max(0, Math.min(1, clip.volume));
}

function tick(now: number): void {
  if (!playing.value) return;
  const dt = lastWall ? (now - lastWall) / 1000 : 0;
  lastWall = now;
  const clip = clipAt(playhead.value);
  if (activeIsImage.value && clip && !switching) {
    // 图片片段没有媒体时钟，用墙钟推进。
    let time = playhead.value + dt;
    if (time >= clip.start + clip.duration) time = clip.start + clip.duration;
    playhead.value = time;
  } else if (!activeIsImage.value) {
    const el = videoEl.value;
    const current = activeClip.value;
    if (el && current) {
      const t = current.start + (el.currentTime - current.in) / (current.speed > 0 ? current.speed : 1);
      playhead.value = Math.max(playhead.value, Math.min(t, duration.value));
    }
  }
  if (playhead.value >= duration.value - 0.02) {
    playing.value = false;
    playhead.value = duration.value;
    return;
  }
  const next = clipAt(playhead.value);
  if (next && next.id !== activeClip.value?.id) void loadActive(playhead.value);
  syncAudio(playhead.value, true);
  raf = requestAnimationFrame(tick);
}

watch(playing, async (value) => {
  stopLoop();
  lastWall = 0;
  if (value) {
    if (playhead.value >= duration.value - 0.02) playhead.value = 0;
    await loadActive(playhead.value);
    const el = videoEl.value;
    if (el && !activeIsImage.value) void el.play().catch(() => {});
    syncAudio(playhead.value, true);
    raf = requestAnimationFrame(tick);
  } else {
    videoEl.value?.pause();
    syncAudio(playhead.value, false);
  }
});

// 外部 seek（时间线点击/拖动）：重载片段并同步元素。
watch(playhead, async (time) => {
  if (playing.value) return;
  await loadActive(time);
  syncAudio(time, false);
});

watch(
  () => project.clips.map((clip) => `${clip.id}:${clip.start}:${clip.duration}:${clip.in}:${clip.out}:${clip.speed}:${clip.muted}:${clip.volume}`).join('|'),
  () => {
    if (!playing.value) void loadActive(playhead.value);
    else if (activeClip.value && !videoClips.value.some((clip) => clip.id === activeClip.value?.id)) {
      void loadActive(playhead.value);
    }
  },
);

onUnmounted(() => {
  stopLoop();
  releasePool();
});
</script>

<template>
  <div class="preview-area">
    <div class="preview-frame" :style="ratioStyle">
      <img v-if="activeIsImage && previewUrl" :src="previewUrl" alt="" />
      <video
        v-else
        ref="videoEl"
        :src="previewUrl || undefined"
        :style="videoStyle"
        playsinline
        @ended="playing = false"
      ></video>
      <div class="preview-overlay">
        <div v-for="item in overlayTexts" :key="item.id" class="text-item" :style="item.style">{{ item.content }}</div>
      </div>
      <div v-if="!videoClips.length" class="empty" style="position:absolute; inset:0; color:#98a2b8">
        <div class="big">🎬</div>
        <div>{{ t('emptyTimelineHint') }}</div>
      </div>
    </div>
    <div class="preview-controls">
      <button class="icon-only" :title="playing ? t('pause') : t('play')" @click="playing = !playing">
        {{ playing ? '⏸' : '▶' }}
      </button>
      <span class="time">{{ t('timePosition', { time: formatTime(playhead), total: formatTime(duration) }) }}</span>
      <input
        type="range"
        min="0"
        :max="Math.max(duration, 0.1)"
        step="0.01"
        :value="playhead"
        @input="playhead = Number(($event.target as HTMLInputElement).value)"
      />
    </div>
  </div>
</template>
