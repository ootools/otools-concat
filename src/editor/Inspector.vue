<script setup lang="ts">
import { computed } from 'vue';
import { t } from '../i18n';
import {
  assetById,
  deleteSelected,
  playhead,
  project,
  selectedClip,
  splitAtPlayhead,
  updateClip,
} from './store';
import { FILTER_PRESETS, type ClipFilter } from '../types';

const clip = selectedClip;
const asset = computed(() => assetById(clip.value?.assetId));
const isVideoClip = computed(() => {
  const track = project.tracks.find((trackItem) => trackItem.id === clip.value?.trackId);
  return track?.kind === 'video';
});
const isTextClip = computed(() => {
  const track = project.tracks.find((trackItem) => trackItem.id === clip.value?.trackId);
  return track?.kind === 'text';
});

function activePreset(filter?: ClipFilter): string | null {
  if (!filter) return 'none';
  for (const [name, value] of Object.entries(FILTER_PRESETS)) {
    if (!value) continue;
    const same = ['brightness', 'contrast', 'saturation'].every(
      (key) => Math.abs(value[key as keyof ClipFilter] - filter[key as keyof ClipFilter]) < 0.004,
    );
    if (same) return name;
  }
  return 'custom';
}

function applyPreset(name: string) {
  if (!clip.value) return;
  const preset = FILTER_PRESETS[name];
  updateClip(clip.value.id, (target) => {
    target.filter = preset ? { ...preset } : undefined;
  });
}

function updateFilterPart(key: keyof ClipFilter, value: number) {
  if (!clip.value) return;
  updateClip(clip.value.id, (target) => {
    const base: ClipFilter = target.filter ?? { brightness: 1, contrast: 1, saturation: 1 };
    target.filter = { ...base, [key]: value };
  });
}

function updateText(key: string, value: string | number | boolean) {
  if (!clip.value?.text) return;
  updateClip(clip.value.id, (target) => {
    if (target.text) (target.text as unknown as Record<string, unknown>)[key] = value;
  });
}

const presetNames = computed(() => ['none', 'warm', 'cool', 'vivid', 'mono', 'fade']);
const presetLabel = (name: string) => t(`filter${name.charAt(0).toUpperCase()}${name.slice(1)}` as Parameters<typeof t>[0]);
</script>

<template>
  <aside class="inspector">
    <div class="panel-title">{{ t('inspector') }}</div>
    <div v-if="!clip" class="empty">
      <div class="big">✂️</div>
      <div>{{ t('emptyTimelineHint') }}</div>
    </div>

    <template v-else>
      <div class="section">
        <div class="row" style="justify-content: space-between">
          <strong style="font-size: 12px">{{ asset?.info.name ?? t('textSection') }}</strong>
          <span style="font-size: 11px; color: var(--cc-text-2)">{{ clip.duration.toFixed(2) }}s</span>
        </div>
        <div class="row" style="margin-top: 8px; gap: 6px">
          <button :disabled="playhead <= clip.start || playhead >= clip.start + clip.duration" @click="splitAtPlayhead">
            ✂ {{ t('splitClip') }}
          </button>
          <button class="ghost" style="color: var(--cc-danger)" @click="deleteSelected">🗑 {{ t('deleteClip') }}</button>
        </div>
      </div>

      <div v-if="isVideoClip" class="section">
        <label class="field" style="margin-bottom: 8px">
          {{ t('speedLabel') }}
          <div class="slider-row" style="margin: 0">
            <input
              type="range" min="0.25" max="4" step="0.05"
              :value="clip.speed"
              @input="updateClip(clip.id, (target) => { const value = Number(($event.target as HTMLInputElement).value); const ratio = (target.speed || 1) / value; target.speed = value; target.out = Math.min(target.in + target.duration * value, (assetById(target.assetId)?.info.duration ?? 3600)); target.duration = (target.out - target.in) / value; void ratio; })"
            />
            <span class="value">{{ clip.speed.toFixed(2) }}×</span>
          </div>
        </label>
        <label class="field" style="margin-bottom: 8px">
          {{ t('volumeLabel') }}
          <div class="slider-row" style="margin: 0">
            <input type="range" min="0" max="1" step="0.01" :value="clip.volume" @input="updateClip(clip.id, (target) => { target.volume = Number(($event.target as HTMLInputElement).value) })" />
            <span class="value">{{ Math.round(clip.volume * 100) }}%</span>
          </div>
        </label>
        <div class="row" style="margin-bottom: 8px">
          <input type="checkbox" :checked="clip.muted" @change="updateClip(clip.id, (target) => { target.muted = ($event.target as HTMLInputElement).checked })" />
          <span>{{ t('muteLabel') }}</span>
        </div>
        <label class="field">
          {{ t('filterLabel') }}
          <div class="preset-chips" style="margin-top: 4px">
            <button
              v-for="name in presetNames"
              :key="name"
              :class="{ active: activePreset(clip.filter) === name }"
              @click="applyPreset(name)"
            >{{ presetLabel(name) }}</button>
          </div>
        </label>
        <template v-if="clip.filter">
          <label class="field" style="margin-top: 8px">
            {{ t('brightnessLabel') }}
            <div class="slider-row" style="margin: 0">
              <input type="range" min="0.3" max="1.8" step="0.01" :value="clip.filter.brightness" @input="updateFilterPart('brightness', Number(($event.target as HTMLInputElement).value))" />
              <span class="value">{{ clip.filter.brightness.toFixed(2) }}</span>
            </div>
          </label>
          <label class="field" style="margin-top: 8px">
            {{ t('contrastLabel') }}
            <div class="slider-row" style="margin: 0">
              <input type="range" min="0.3" max="2.2" step="0.01" :value="clip.filter.contrast" @input="updateFilterPart('contrast', Number(($event.target as HTMLInputElement).value))" />
              <span class="value">{{ clip.filter.contrast.toFixed(2) }}</span>
            </div>
          </label>
          <label class="field" style="margin-top: 8px">
            {{ t('saturationLabel') }}
            <div class="slider-row" style="margin: 0">
              <input type="range" min="0" max="2.5" step="0.01" :value="clip.filter.saturation" @input="updateFilterPart('saturation', Number(($event.target as HTMLInputElement).value))" />
              <span class="value">{{ clip.filter.saturation.toFixed(2) }}</span>
            </div>
          </label>
        </template>
      </div>

      <div v-if="isTextClip && clip.text" class="section">
        <label class="field" style="margin-bottom: 8px">
          {{ t('textContent') }}
          <textarea rows="3" :placeholder="t('textPlaceholder')" :value="clip.text.content" @input="updateText('content', ($event.target as HTMLTextAreaElement).value)"></textarea>
        </label>
        <label class="field" style="margin-bottom: 8px">
          {{ t('fontSizeLabel') }}
          <div class="slider-row" style="margin: 0">
            <input type="range" min="16" max="200" step="1" :value="clip.text.fontSize" @input="updateText('fontSize', Number(($event.target as HTMLInputElement).value))" />
            <span class="value">{{ clip.text.fontSize }}</span>
          </div>
        </label>
        <div class="row" style="margin-bottom: 8px">
          <label class="field" style="flex:1">
            {{ t('colorLabel') }}
            <input type="color" :value="clip.text.color" @input="updateText('color', ($event.target as HTMLInputElement).value)" />
          </label>
          <label class="field" style="flex:1">
            {{ t('strokeLabel') }}
            <input type="color" :value="clip.text.strokeColor" @input="updateText('strokeColor', ($event.target as HTMLInputElement).value)" />
          </label>
        </div>
        <label class="field" style="margin-bottom: 8px">
          {{ t('strokeWidthLabel') }}
          <div class="slider-row" style="margin: 0">
            <input type="range" min="0" max="24" step="1" :value="clip.text.strokeWidth" @input="updateText('strokeWidth', Number(($event.target as HTMLInputElement).value))" />
            <span class="value">{{ clip.text.strokeWidth }}</span>
          </div>
        </label>
        <label class="field" style="margin-bottom: 8px">
          {{ t('positionLabel') }} X
          <div class="slider-row" style="margin: 0">
            <input type="range" min="0" max="1" step="0.01" :value="clip.text.x" @input="updateText('x', Number(($event.target as HTMLInputElement).value))" />
            <span class="value">{{ clip.text.x.toFixed(2) }}</span>
          </div>
        </label>
        <label class="field" style="margin-bottom: 8px">
          {{ t('positionLabel') }} Y
          <div class="slider-row" style="margin: 0">
            <input type="range" min="0" max="1" step="0.01" :value="clip.text.y" @input="updateText('y', Number(($event.target as HTMLInputElement).value))" />
            <span class="value">{{ clip.text.y.toFixed(2) }}</span>
          </div>
        </label>
        <div class="row">
          <button :class="{ active: clip.text.align === 'left' }" @click="updateText('align', 'left')">{{ t('alignLeft') }}</button>
          <button :class="{ active: clip.text.align === 'center' }" @click="updateText('align', 'center')">{{ t('alignCenter') }}</button>
          <button :class="{ active: clip.text.align === 'right' }" @click="updateText('align', 'right')">{{ t('alignRight') }}</button>
          <button :class="{ active: clip.text.bold }" @click="updateText('bold', !clip.text!.bold)"><b>B</b></button>
          <button :class="{ active: clip.text.italic }" @click="updateText('italic', !clip.text!.italic)"><i>I</i></button>
        </div>
      </div>
    </template>
  </aside>
</template>
