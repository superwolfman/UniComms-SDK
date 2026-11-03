import type { ApiPort, Message, Snapshot, SocketPort, StoragePort, TimerPort, TransportPort } from "@unicomms/core";

/** Structural ports keep the SDK core free of React Native runtime imports. */
export interface NativeWebSocket extends SocketPort {}
export type NativeWebSocketFactory = (url: string) => NativeWebSocket;
export interface AsyncKeyValueStore { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> }

export class NativeTransport implements TransportPort {
  constructor(private readonly createSocket: NativeWebSocketFactory) {}
  connect(url: string): SocketPort { return this.createSocket(url); }
}

/** Bridges the React Native WebSocket event object to the core's string-frame port. */
export function adaptNativeWebSocket(socket: WebSocket): SocketPort {
  return new class implements SocketPort {
    onopen: (() => void) | null = null;
    onmessage: ((data: string) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor() {
      socket.onopen = () => this.onopen?.();
      socket.onmessage = event => { if (typeof event.data === "string") this.onmessage?.(event.data); };
      socket.onerror = () => this.onerror?.();
      socket.onclose = () => this.onclose?.();
    }
    get readyState(): number { return socket.readyState; }
    send(data: string): void { socket.send(data); }
    close(code?: number): void { socket.close(code); }
  }();
}

export class AsyncStorageAdapter implements StoragePort {
  constructor(private readonly storage: AsyncKeyValueStore, private readonly namespace: string) {
    if (!namespace || namespace.length > 80) throw new Error("A bounded storage namespace is required");
  }
  async loadSnapshot(conversationId: string): Promise<Snapshot> {
    return (await this.read<Snapshot>(`snapshot:${conversationId}`)) ?? { cursor: 0, messages: [] };
  }
  saveSnapshot(conversationId: string, snapshot: Snapshot): Promise<void> { return this.write(`snapshot:${conversationId}`, snapshot); }
  async loadOutbox(): Promise<Message[]> { return (await this.read<Message[]>("outbox")) ?? []; }
  saveOutbox(messages: Message[]): Promise<void> { return this.write("outbox", messages); }
  private async read<T>(key: string): Promise<T | null> {
    const raw = await this.storage.getItem(this.key(key)); if (raw === null) return null;
    try { return JSON.parse(raw) as T; } catch { throw new Error(`Corrupt persisted SDK state (${key})`); }
  }
  private async write(key: string, value: unknown): Promise<void> { await this.storage.setItem(this.key(key), JSON.stringify(value)); }
  private key(key: string): string { return `unicomms:${this.namespace}:${key}`; }
}

/** Reuse the REST contract while allowing a React Native fetch implementation to be injected. */
export class NativeHttpApi implements ApiPort {
  constructor(private readonly baseUrl: string, private readonly token: () => string, private readonly fetcher: typeof fetch = fetch) {}
  conversations(): Promise<Awaited<ReturnType<ApiPort["conversations"]>>> { return this.request("/api/v1/conversations"); }
  history(id: string, after: number, limit: number): Promise<Awaited<ReturnType<ApiPort["history"]>>> { return this.request(`/api/v1/conversations/${encodeURIComponent(id)}/messages?after=${after}&limit=${limit}`); }
  historyBefore(id: string, before: number, limit: number): Promise<Awaited<ReturnType<ApiPort["historyBefore"]>>> { return this.request(`/api/v1/conversations/${encodeURIComponent(id)}/messages?before=${before}&limit=${limit}`); }
  send(message: Parameters<ApiPort["send"]>[0]): ReturnType<ApiPort["send"]> { return this.request(`/api/v1/conversations/${encodeURIComponent(message.conversationId)}/messages`, { method: "POST", body: JSON.stringify(message) }); }
  async markRead(id: string, seq: number): Promise<void> { await this.request(`/api/v1/conversations/${encodeURIComponent(id)}/read`, { method: "PUT", body: JSON.stringify({ seq }) }); }
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(new URL(path, this.baseUrl), { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token()}`, ...init.headers } });
    if (!response.ok) throw new Error(`UniComms API request failed (${response.status})`);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
}

export function createNativeTimers(now: () => number = Date.now, uuid: () => string): TimerPort {
  return { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>), setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>), now, uuid, random: Math.random };
}
