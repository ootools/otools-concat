/** 宿主能力适配：文件选择/拖拽/打开关联/sidecar spawn。浏览器模式降级提示。 */
import { open, save } from '@tauri-apps/plugin-dialog';
import { getOtoolsApi, invoke, listen } from 'otools-plugin-sdk/runtime';
import { onOtoolsOpenFile } from 'otools-plugin-sdk';
import type { SidecarApi } from 'otools-plugin-sdk';
import { connectConcatd, type SidecarConnection } from './service.ts';

export const MEDIA_FILTERS = [
  { name: 'Media', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mpg', 'mpeg', 'ts', 'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'jpg', 'jpeg'] },
  { name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi'] },
  { name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus'] },
  { name: 'Image', extensions: ['jpg', 'jpeg'] },
  { name: 'Concat Project', extensions: ['concatproj'] },
];

function sidecar(api: unknown): SidecarApi | undefined {
  return (api as { sidecar?: SidecarApi } | undefined)?.sidecar;
}

export interface HostAdapter {
  kind: 'otools' | 'browser';
  hasSidecar: boolean;
  pickMedia(): Promise<string[]>;
  pickProject(): Promise<string | null>;
  saveProjectPath(defaultName: string): Promise<string | null>;
  listenFiles(handler: (paths: string[]) => void): Promise<() => void>;
  connect(): Promise<SidecarConnection>;
}

export function createHostAdapter(): HostAdapter {
  const api = getOtoolsApi() as Record<string, unknown> | undefined;
  const isOtools = Boolean(api && (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  return {
    kind: isOtools ? 'otools' : 'browser',
    hasSidecar: Boolean(isOtools && sidecar(api)?.spawn),
    async pickMedia() {
      if (!api) return [];
      const options = { multiple: true, directory: false, title: 'Concat', filters: MEDIA_FILTERS };
      const pick = api.pickFiles as ((options: unknown) => Promise<string[] | string>) | undefined;
      const result = typeof pick === 'function' ? await pick(options) : await open(options);
      return Array.isArray(result) ? result : typeof result === 'string' ? [result] : [];
    },
    async pickProject() {
      if (!api) return null;
      const options = {
        multiple: false,
        directory: false,
        title: 'Concat',
        filters: [{ name: 'Concat Project', extensions: ['concatproj'] }],
      };
      const pick = api.pickFiles as ((options: unknown) => Promise<string[] | string>) | undefined;
      const result = typeof pick === 'function' ? await pick(options) : await open(options);
      if (Array.isArray(result)) return result[0] ?? null;
      return typeof result === 'string' ? result : null;
    },
    async saveProjectPath(defaultName: string) {
      if (!api) return null;
      return await save({ title: 'Concat', defaultPath: defaultName.endsWith('.concatproj') ? defaultName : `${defaultName}.concatproj`, filters: [{ name: 'Concat Project', extensions: ['concatproj'] }] });
    },
    async listenFiles(handler) {
      if (!isOtools) return () => {};
      const stops: Array<() => void> = [];
      const openFileStop = await onOtoolsOpenFile((files) => {
        const paths = files.map((file) => (file as { path?: string }).path).filter((path): path is string => Boolean(path));
        if (paths.length) handler(paths);
      });
      stops.push(() => void openFileStop?.());
      if ((window as unknown as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__?.invoke) {
        const dropStop = await listen<{ paths?: string[] }>('tauri://drag-drop', (event) => {
          if (Array.isArray(event.payload?.paths)) handler(event.payload.paths.filter((path) => typeof path === 'string'));
        });
        stops.push(() => void dropStop());
      }
      return () => stops.forEach((stop) => stop());
    },
    async connect() {
      const apiSidecar = sidecar(api);
      if (!apiSidecar?.spawn) {
        throw new Error('This host does not support sidecars. OTools 0.9.8+ is required.');
      }
      return await connectConcatd(apiSidecar);
    },
  };
}

export { invoke };
