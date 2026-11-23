<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { t } from './i18n';
import MediaLibrary from './editor/MediaLibrary.vue';
import PreviewPlayer from './editor/PreviewPlayer.vue';
import Timeline from './editor/Timeline.vue';
import Inspector from './editor/Inspector.vue';
import ExportDialog from './editor/ExportDialog.vue';
import {
  adapter,
  client,
  connectService,
  deleteSelected,
  duration,
  history,
  importPaths,
  importState,
  newProject,
  openProject,
  playhead,
  playing,
  saveProjectAs,
  selection,
  serviceError,
  serviceState,
  splitAtPlayhead,
  toast,
} from './editor/store';

const dragging = ref(false);
const showExport = ref(false);
const confirmNew = ref(false);
let stopFiles: (() => void) | undefined;

const statusLabel = (state: string) => {
  if (state === 'ready') return t('tagline');
  if (state === 'connecting') return t('loading');
  return t('errorSidecar');
};

onMounted(async () => {
  void connectService();
  stopFiles = await adapter.listenFiles((paths) => void importPaths(paths));
  window.addEventListener('keydown', onKeyDown);
});

onUnmounted(() => {
  stopFiles?.();
  window.removeEventListener('keydown', onKeyDown);
});

watch(serviceError, (message) => {
  if (message) console.warn('[concat] service error:', message);
});

function onKeyDown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
  if (event.code === 'Space') {
    event.preventDefault();
    playing.value = !playing.value;
  } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
    event.preventDefault();
    if (history.canUndo()) history.undo();
  } else if ((event.metaKey || event.ctrlKey) && (event.key.toLowerCase() === 'y' || (event.shiftKey && event.key.toLowerCase() === 'z'))) {
    event.preventDefault();
    if (history.canRedo()) history.redo();
  } else if (event.key.toLowerCase() === 's' && !event.metaKey && !event.ctrlKey) {
    if (selection.value) splitAtPlayhead();
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    if (selection.value) deleteSelected();
  } else if (event.key === 'ArrowLeft') {
    playhead.value = Math.max(0, playhead.value - (event.shiftKey ? 1 : 1 / 30));
  } else if (event.key === 'ArrowRight') {
    playhead.value = Math.min(duration.value, playhead.value + (event.shiftKey ? 1 : 1 / 30));
  }
}

async function confirmNewProject() {
  confirmNew.value = false;
  newProject();
}
</script>

<template>
  <div
    class="editor"
  >
    <header class="topbar">
      <span class="title">Concat</span>
      <button class="ghost" @click="confirmNew = true">{{ t('newProject') }}</button>
      <button class="ghost" @click="openProject">{{ t('openProject') }}</button>
      <button class="ghost" @click="saveProjectAs">{{ t('saveProject') }}</button>
      <span class="status">|</span>
      <button class="icon-only ghost" :disabled="!history.canUndo()" :title="t('undo')" @click="history.canUndo() && history.undo()">↶</button>
      <button class="icon-only ghost" :disabled="!history.canRedo()" :title="t('redo')" @click="history.canRedo() && history.redo()">↷</button>
      <span class="status">{{ statusLabel(serviceState) }}</span>
      <button class="primary" :disabled="!client" @click="showExport = true">⬇ {{ t('exportTitle') }}</button>
    </header>

    <div class="workspace">
      <MediaLibrary />
      <div class="stage">
        <PreviewPlayer />
        <Timeline />
      </div>
      <Inspector />
    </div>

    <div v-if="dragging" class="drop-hint">{{ t('dropToImport') }}</div>
    <div v-if="toast" class="toast">{{ toast }}</div>
    <div v-if="importState === 'importing'" class="toast">{{ t('importing') }}</div>

    <div v-if="confirmNew" class="dialog-backdrop" @click.self="confirmNew = false">
      <div class="dialog">
        <h3>{{ t('newProject') }}</h3>
        <p>{{ t('confirmLoseChanges') }}</p>
        <div class="actions">
          <button @click="confirmNew = false">{{ t('cancel') }}</button>
          <button class="primary" @click="confirmNewProject">{{ t('ok') }}</button>
        </div>
      </div>
    </div>

    <ExportDialog v-if="showExport" @close="showExport = false" />
  </div>
</template>
