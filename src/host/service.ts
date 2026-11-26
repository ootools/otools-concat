/**
 * concatd sidecar 客户端：spawn → stdio 握手 → loopback HTTP。
 * 媒体/缩略图/预览 URL 直接交给 <video>/<img>（无法设请求头），
 * 走 ?access_token= 的一次性 query 回退（仅 GET、loopback、双头校验）。
 */
import type { SidecarApi, SidecarEvent } from 'otools-plugin-sdk';
import type { MediaInfo } from '../types.ts';

export class ConcatdError extends Error {
  constructor(
    public readonly code: 'quota' | 'startup' | 'network' | 'media',
    message: string,
  ) {
    super(message);
    this.name = 'ConcatdError';
  }
}

interface ReadyMessage {
  event: 'ready';
  port: number;
  protocol: 1;
}

export class JsonLineBuffer {
  private carry = '';
  constructor(private readonly maxLineBytes = 64 * 1024) {}

  push(chunk: string): unknown[] {
    this.carry += chunk;
    const lines = this.carry.split('\n');
    if (lines.some((line) => new TextEncoder().encode(line).byteLength > this.maxLineBytes)) {
      this.carry = '';
      throw new Error('sidecar stdout line exceeded limit');
    }
    this.carry = lines.pop() ?? '';
    return lines.flatMap((line) => {
      const text = line.trim();
      if (!text) return [];
      try {
        return [JSON.parse(text) as unknown];
      } catch {
        return [];
      }
    });
  }

  reset(): void {
    this.carry = '';
  }
}

export function parseReady(value: unknown): ReadyMessage | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (
    record.event !== 'ready' ||
    record.protocol !== 1 ||
    typeof record.port !== 'number' ||
    !Number.isInteger(record.port) ||
    record.port < 1 ||
    record.port > 65535
  ) {
    return null;
  }
  return { event: "ready", port: record.port, protocol: 1 } as ReadyMessage;
}

export function createSessionToken(): string {
  const bytes = new Uint8Array(32);
  if (!globalThis.crypto?.getRandomValues) throw new Error('Secure random tokens are unavailable');
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function loopbackOrigin(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConcatdError('startup', 'invalid sidecar port');
  return `http://127.0.0.1:${port}`;
}

export interface SidecarConnection {
  origin: string;
  token: string;
  dispose(): Promise<void>;
}

export async function connectConcatd(api: SidecarApi, timeoutMs = 15_000): Promise<SidecarConnection> {
  const token = createSessionToken();
  const lines = new JsonLineBuffer();
  let handle = '';
  let stop: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const early: SidecarEvent[] = [];
  let resolveReady!: (port: number) => void;
  let rejectReady!: (reason: Error) => void;
  const ready = new Promise<number>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    if (timer) clearTimeout(timer);
    stop?.();
    lines.reset();
    if (handle) {
      try {
        await api.kill(handle);
      } catch {
        /* 宿主视图生命周期是最终清理权威 */
      }
    }
  };
  const receive = (event: SidecarEvent) => {
    if (disposed) return;
    if (!handle) {
      if (early.length < 32) early.push(event);
      return;
    }
    if (event.handle !== handle) return;
    if (event.event === 'exit' || event.event === 'overflow') {
      rejectReady(new ConcatdError('startup', 'The media service stopped before it was ready.'));
      return;
    }
    if (event.event !== 'output' || event.stream !== 'stdout') return;
    try {
      for (const line of lines.push(event.data)) {
        const value = parseReady(line);
        if (value) resolveReady(value.port);
      }
    } catch {
      rejectReady(new ConcatdError('startup', 'The media service sent an invalid handshake.'));
    }
  };
  try {
    stop = await api.onEvent(receive);
    const spawned = await api.spawn('concatd', ['--stdio'], { lifetime: 'view' });
    handle = spawned.handle;
    for (const event of early) receive(event);
    timer = setTimeout(() => rejectReady(new ConcatdError('startup', 'The media service did not become ready.')), timeoutMs);
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1';
    await api.writeStdin(handle, `${JSON.stringify({ type: 'init', token, origin })}\n`);
    const port = await ready;
    clearTimeout(timer);
    return { origin: loopbackOrigin(port), token, dispose };
  } catch (error) {
    await dispose();
    const message = error instanceof Error ? error.message : String(error);
    if (/quota|limit|最多|上限|8.*(?:slot|进程|服务)|too many/i.test(message)) {
      throw new ConcatdError('quota', 'All sidecar slots are in use');
    }
    if (error instanceof ConcatdError) throw error;
    throw new ConcatdError('startup', 'Unable to start the media service. Check the installed media runtime.');
  }
}

/** Publish a client only after the HTTP health check; failed sessions must release their sidecar. */
export async function createReadyClient(connection: SidecarConnection, fetcher?: typeof fetch): Promise<ConcatdClient> {
  const client = new ConcatdClient(connection, fetcher);
  try {
    await client.status();
    return client;
  } catch (error) {
    await connection.dispose();
    throw error;
  }
}

export interface RenderProgressEvent {
  state: 'running' | 'done' | 'failed' | 'cancelled';
  seconds: number;
  percent: number;
}

export interface RenderStartResponse {
  renderId: string;
}

export interface ProbeResponse {
  mediaId: string;
  info: MediaInfo;
  previewMode: 'browser' | 'remux' | 'proxy';
}

export interface RenderInputSpec {
  path?: string;
  lavfi?: string;
  loopImage?: boolean;
  imageDuration?: number;
  duration?: number;
}

export interface RenderRequestBody {
  inputs: RenderInputSpec[];
  filterComplex: string;
  expectedDuration: number;
  output: string;
  quality?: 'high' | 'medium' | 'low';
  hasAudio?: boolean;
}

export class ConcatdClient {
  constructor(
    private readonly connection: SidecarConnection,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  get origin(): string {
    return this.connection.origin;
  }

  private async request<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await this.fetcher(`${this.connection.origin}${path}`, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${this.connection.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        let message = `concatd request failed (${response.status})`;
        try {
          const payload = (await response.json()) as { error?: string };
          if (payload?.error) message = payload.error;
        } catch {
          /* 保留默认信息 */
        }
        throw new ConcatdError(response.status === 429 ? 'quota' : 'media', message);
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof ConcatdError) throw error;
      throw new ConcatdError('network', 'The local media service is unavailable.');
    } finally {
      clearTimeout(timeout);
    }
  }

  status(): Promise<{ uptimeSeconds: number }> {
    return this.request('/api/status');
  }

  probe(path: string): Promise<ProbeResponse> {
    return this.request('/api/probe', { path });
  }

  /** 授权媒体 URL（供 <video src> / fetch 用）：query token 仅限 GET 媒体路由。 */
  private mediaQuery(path: string): string {
    if (!path.startsWith('/api/media/') && !path.startsWith('/api/assets/')) {
      throw new ConcatdError('media', 'refusing to authorize a non-media URL');
    }
    const url = new URL(path, this.connection.origin);
    if (url.origin !== this.connection.origin) throw new ConcatdError('media', 'media URL origin mismatch');
    url.searchParams.set('access_token', this.connection.token);
    return url.href;
  }

  previewUrl(mediaId: string): string {
    return this.mediaQuery(`/api/media/${encodeURIComponent(mediaId)}/preview.mp4`);
  }

  originalUrl(mediaId: string): string {
    return this.mediaQuery(`/api/media/${encodeURIComponent(mediaId)}`);
  }

  thumbUrl(mediaId: string, at = 0): string {
    return this.mediaQuery(`/api/media/${encodeURIComponent(mediaId)}/thumb.jpg?at=${at}`);
  }

  async peaks(mediaId: string): Promise<{ peaks: number[] }> {
    return this.request(`/api/media/${encodeURIComponent(mediaId)}/peaks.json`);
  }

  /** 图片原始字节 URL（<img> 预览）。 */
  imageUrl(mediaId: string): string {
    return this.mediaQuery(`/api/media/${encodeURIComponent(mediaId)}`);
  }

  async uploadText(dataBase64: string): Promise<{ assetId: string }> {
    return this.request('/api/assets/text', { dataBase64 });
  }

  textAssetUrl(assetId: string): string {
    return this.mediaQuery(`/api/assets/text/${encodeURIComponent(assetId)}.png`);
  }

  render(body: RenderRequestBody): Promise<RenderStartResponse> {
    return this.request('/api/render', body);
  }

  renderStatus(renderId: string): Promise<RenderProgressEvent> {
    return this.request(`/api/render/${encodeURIComponent(renderId)}`);
  }

  /** SSE 进度流（EventSource 无法带 header，用 query token）。 */
  renderEventsUrl(renderId: string): string {
    const url = new URL(`/api/render/${encodeURIComponent(renderId)}/events`, this.connection.origin);
    url.searchParams.set('access_token', this.connection.token);
    return url.href;
  }

  async cancel(renderId: string): Promise<void> {
    await this.request(`/api/render/${encodeURIComponent(renderId)}/cancel`, {});
  }

  async saveProject(path: string, dataBase64: string): Promise<void> {
    await this.request('/api/project', { path, dataBase64 });
  }

  async readProject(path: string): Promise<{ dataBase64: string; size: number }> {
    const url = new URL('/api/project', this.connection.origin);
    url.searchParams.set('path', path);
    const response = await this.fetcher(url.href, {
      credentials: 'omit',
      cache: 'no-store',
      headers: { Authorization: `Bearer ${this.connection.token}` },
    });
    if (!response.ok) throw new ConcatdError('media', `cannot read project (${response.status})`);
    return (await response.json()) as { dataBase64: string; size: number };
  }

  async close(): Promise<void> {
    try {
      await this.request('/api/close', {});
    } catch {
      /* 服务可能已随视图退出 */
    } finally {
      await this.connection.dispose();
    }
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
