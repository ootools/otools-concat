<script setup lang="ts">
import { computed, ref } from 'vue';
import { t } from '../i18n';
import { client, duration, exportState, project, startExport } from './store';

const emit = defineEmits<{ close: [] }>();

const outputPath = ref('');
const saving = ref(false);
const error = ref<string | null>(null);
const done = ref(false);

const canExport = computed(() => Boolean(client.value) && duration.value > 0 && !exportState.value.active);

async function chooseAndExport() {
  error.value = null;
  saving.value = true;
  try {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({
      title: 'Concat',
      defaultPath: 'concat-export.mp4',
      filters: [{ name: 'MP4', extensions: ['mp4'] }],
    });
    if (!path) return;
    outputPath.value = path;
    await startExport(path);
    done.value = true;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (message !== 'cancelled') error.value = message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="dialog-backdrop" @click.self="!exportState.active && emit('close')">
    <div class="dialog">
      <h3>{{ t('exportTitle') }}</h3>
      <template v-if="!exportState.active && !done">
        <p style="font-size: 12px; color: var(--cc-text-2); margin: 0 0 6px">
          {{ t('resolutionLabel') }} {{ project.meta.resolution.width }}×{{ project.meta.resolution.height }} ·
          {{ t('qualityLabel') }} {{ t(`quality${project.meta.quality.charAt(0).toUpperCase()}${project.meta.quality.slice(1)}` as Parameters<typeof t>[0]) }}
        </p>
        <p v-if="!client" style="color: var(--cc-danger); font-size: 12px">{{ t('errorSidecar') }}</p>
        <p v-else-if="duration <= 0" style="color: var(--cc-danger); font-size: 12px">{{ t('exportNoClips') }}</p>
        <p v-if="error" style="color: var(--cc-danger); font-size: 12px">{{ error }}</p>
        <div class="actions">
          <button @click="emit('close')">{{ t('cancel') }}</button>
          <button class="primary" :disabled="!canExport" @click="chooseAndExport">{{ t('exportStart') }}</button>
        </div>
      </template>
      <template v-else-if="exportState.active">
        <p style="font-size: 12px; margin: 0">{{ t('exportProgress', { percent: Math.round(exportState.percent) }) }}</p>
        <div class="progress-track"><div class="progress-fill" :style="{ width: `${exportState.percent}%` }"></div></div>
        <div class="actions">
          <button disabled>{{ t('exporting') }}</button>
        </div>
      </template>
      <template v-else>
        <p style="font-size: 12px; margin: 0">{{ t('exportDone') }}</p>
        <p style="font-size: 11px; color: var(--cc-text-2); word-break: break-all">{{ t('outputPath', { path: outputPath }) }}</p>
        <div class="actions">
          <button class="primary" @click="emit('close')">{{ t('close') }}</button>
        </div>
      </template>
    </div>
  </div>
</template>
