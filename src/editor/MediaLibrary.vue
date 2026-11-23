<script setup lang="ts">
import { computed } from 'vue';
import { t } from '../i18n';
import { addToTimeline, importState, pickAndImport, project, removeAsset } from './store';
import { formatTime } from '../domain/project';

const kindIcon = (kind: string) => (kind === 'video' ? '🎬' : kind === 'audio' ? '🎵' : '🖼️');

const items = computed(() => project.media);
const busy = computed(() => importState.value === 'importing');
</script>

<template>
  <aside class="library">
    <div class="panel-title">{{ t('mediaLibrary') }}</div>
    <div class="row" style="padding: 0 10px 8px">
      <button class="primary" style="flex: 1; justify-content: center" :disabled="busy" @click="pickAndImport">
        ＋ {{ t('importMedia') }}
      </button>
    </div>
    <div v-if="!items.length" class="empty">
      <div class="big">🎞️</div>
      <div>{{ t('emptyMediaTitle') }}</div>
      <div>{{ t('emptyMediaHint') }}</div>
    </div>
    <div class="media-grid">
      <div v-for="asset in items" :key="asset.id" class="media-card" draggable="true">
        <img v-if="asset.info.kind !== 'audio' && asset.thumb" class="media-thumb" :src="asset.thumb" alt="" />
        <div v-else class="media-thumb placeholder">{{ kindIcon(asset.info.kind) }}</div>
        <div class="media-actions">
          <button :title="t('addToTimeline')" @click="addToTimeline(asset.id)">＋</button>
          <button :title="t('removeFromLibrary')" @click="removeAsset(asset.id)">🗑</button>
        </div>
        <div class="media-meta" :title="asset.info.name">
          {{ asset.info.name }}
        </div>
        <div class="media-meta">
          <template v-if="asset.info.kind !== 'image'">{{ t('assetDuration', { time: formatTime(asset.info.duration) }) }}</template>
          <span v-if="asset.info.width && asset.info.height">{{ t('assetResolution', { width: asset.info.width, height: asset.info.height }) }}</span>
        </div>
      </div>
    </div>
  </aside>
</template>
