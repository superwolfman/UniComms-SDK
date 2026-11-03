import type { ApiPort, Conversation, Message, MessagePage, RemoteMessage, Snapshot, SocketPort, StoragePort, TimerPort, TransportPort } from "@unicomms/core";

export class BrowserTransport implements TransportPort {
  connect(url: string): SocketPort {
    return new BrowserSocketPort(new WebSocket(url));
  }
}
class BrowserSocketPort implements SocketPort {
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(private readonly socket: WebSocket) {
    socket.onopen = () => this.onopen?.();
    socket.onmessage = event => { if (typeof event.data === "string") this.onmessage?.(event.data); };
    socket.onerror = () => this.onerror?.();
    socket.onclose = () => this.onclose?.();
  }
  get readyState(): number { return this.socket.readyState; }
  send(data: string): void { this.socket.send(data); }
  close(code?: number): void { this.socket.close(code); }
}

export class IndexedDbStorage implements StoragePort {
  private database: Promise<IDBDatabase> | null = null;
  constructor(private readonly namespace: string) {
    if (!namespace || namespace.length > 80) throw new Error("A bounded storage namespace is required");
  }
  async loadSnapshot(conversationId: string): Promise<Snapshot> {
    return (await this.get<Snapshot>("snapshots", conversationId)) ?? { cursor: 0, messages: [] };
  }
  saveSnapshot(conversationId: string, snapshot: Snapshot): Promise<void> { return this.put("snapshots", conversationId, snapshot); }
  async loadOutbox(): Promise<Message[]> { return (await this.get<Message[]>("outbox", "queue")) ?? []; }
  saveOutbox(messages: Message[]): Promise<void> { return this.put("outbox", "queue", messages); }
  private async get<T>(store: string, key: string): Promise<T | undefined> {
    const db = await this.open();
    return new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(store, "readonly"); const req = tx.objectStore(store).get(`${this.namespace}:${key}`);
      req.onsuccess = () => resolve(req.result as T | undefined); req.onerror = () => reject(req.error ?? new Error("IndexedDB read failed"));
    });
  }
  private async put(store: string, key: string, value: unknown): Promise<void> {
    const db = await this.open();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite"); tx.objectStore(store).put(value, `${this.namespace}:${key}`);
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted")); tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
    });
  }
  private open(): Promise<IDBDatabase> {
    this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open("unicomms-sdk", 1);
      request.onupgradeneeded = () => { const db = request.result; if (!db.objectStoreNames.contains("snapshots")) db.createObjectStore("snapshots"); if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox"); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    return this.database;
  }
}

export class HttpApi implements ApiPort {
  constructor(private readonly baseUrl: string, private readonly token: () => string) {}
  conversations(): Promise<Conversation[]> { return this.get("/api/v1/conversations"); }
  history(conversationId: string, after: number, limit: number): Promise<MessagePage> {
    return this.get(`/api/v1/conversations/${encodeURIComponent(conversationId)}/messages?after=${after}&limit=${limit}`);
  }
  historyBefore(conversationId: string, before: number, limit: number): Promise<MessagePage> {
    return this.get(`/api/v1/conversations/${encodeURIComponent(conversationId)}/messages?before=${before}&limit=${limit}`);
  }
  send(message: Pick<Message, "conversationId" | "clientMessageId" | "kind" | "payload">): Promise<RemoteMessage> {
    return this.post(`/api/v1/conversations/${encodeURIComponent(message.conversationId)}/messages`, message);
  }
  async markRead(conversationId: string, seq: number): Promise<void> { await this.put(`/api/v1/conversations/${encodeURIComponent(conversationId)}/read`, { seq }); }
  private get<T>(path: string): Promise<T> { return this.request<T>(path); }
  private post<T>(path: string, body: unknown): Promise<T> { return this.request<T>(path, { method: "POST", body: JSON.stringify(body) }); }
  private put<T>(path: string, body: unknown): Promise<T> { return this.request<T>(path, { method: "PUT", body: JSON.stringify(body) }); }
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token()}`, ...init.headers } });
    if (!response.ok) { const body: unknown = await response.json().catch(() => null); const message = typeof body === "object" && body !== null && "message" in body && typeof body.message === "string" ? body.message : `HTTP ${response.status}`; throw new Error(message); }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
}

export interface Session { token: string; expiresAt: number; user: { id: string; tenant: string; username: string; displayName: string } }
export class AuthApi {
  constructor(private readonly baseUrl: string) {}
  register(tenant: string, username: string, password: string, displayName: string): Promise<Session> { return this.post("/api/v1/auth/register", { tenant, username, password, displayName }); }
  login(tenant: string, username: string, password: string): Promise<Session> { return this.post("/api/v1/auth/login", { tenant, username, password }); }
  async users(token: string): Promise<Session["user"][]> { const response = await fetch(new URL("/api/v1/users", this.baseUrl), { headers: { Authorization: `Bearer ${token}` } }); if (!response.ok) throw new Error(`Unable to load users (${response.status})`); return await response.json() as Session["user"][]; }
  async createConversation(token: string, title: string, memberIds: string[]): Promise<Conversation> { const response = await fetch(new URL("/api/v1/conversations", this.baseUrl), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ title, memberIds }) }); if (!response.ok) throw new Error(`Unable to create conversation (${response.status})`); return await response.json() as Conversation; }
  private async post(path: string, body: unknown): Promise<Session> { const response = await fetch(new URL(path, this.baseUrl), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); if (!response.ok) { const payload: unknown = await response.json().catch(() => null); throw new Error(typeof payload === "object" && payload !== null && "message" in payload && typeof payload.message === "string" ? payload.message : `Request failed (${response.status})`); } return await response.json() as Session; }
}

export const browserTimers: TimerPort = {
  setTimeout: (callback, ms) => window.setTimeout(callback, ms), clearTimeout: (id) => window.clearTimeout(id as number),
  setInterval: (callback, ms) => window.setInterval(callback, ms), clearInterval: (id) => window.clearInterval(id as number),
  now: () => Date.now(), uuid: () => crypto.randomUUID(), random: () => Math.random(),
};
