export type ConnectionState = "idle" | "connecting" | "authenticating" | "syncing" | "online" | "backoff" | "closed";
export type DeliveryState = "queued" | "sending" | "sent" | "failed";
export interface User { id: string; tenant: string; username: string; displayName: string }
export interface Conversation { id: string; title: string; lastSeq: number; readSeq: number; memberIds: string[] }
export interface Message<P = unknown> {
  id: string; conversationId: string; senderId: string; clientMessageId: string; seq: number;
  kind: string; payload: P; createdAt: number; delivery: DeliveryState;
}
export interface RemoteMessage {
  id: string; conversationId: string; senderId: string; clientMessageId: string; seq: number;
  kind: string; payload: unknown; createdAt: number;
}
export interface MessagePage { items: RemoteMessage[]; nextCursor: number; hasMore: boolean }
export interface SocketFrame<T = unknown> { v: 1; type: string; requestId: string; traceId?: string; payload: T }
export interface SocketPort {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(code?: number): void;
}
export interface TransportPort { connect(url: string): SocketPort }
export interface TimerPort {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  now(): number;
  uuid(): string;
  random(): number;
}
export interface Snapshot { cursor: number; messages: Message[] }
export interface StoragePort {
  loadSnapshot(conversationId: string): Promise<Snapshot>;
  saveSnapshot(conversationId: string, snapshot: Snapshot): Promise<void>;
  loadOutbox(): Promise<Message[]>;
  saveOutbox(messages: Message[]): Promise<void>;
}
export interface ApiPort {
  conversations(): Promise<Conversation[]>;
  history(conversationId: string, after: number, limit: number): Promise<MessagePage>;
  historyBefore(conversationId: string, before: number, limit: number): Promise<MessagePage>;
  send(message: Pick<Message, "conversationId" | "clientMessageId" | "kind" | "payload">): Promise<RemoteMessage>;
  markRead(conversationId: string, seq: number): Promise<void>;
}
export interface LoggerPort { debug(message: string, fields?: Record<string, string | number>): void; warn(message: string, fields?: Record<string, string | number>): void }
export interface MessageCodec<P = unknown> { readonly kind: string; validate(payload: unknown): payload is P }
export interface PluginRegistry { register(codec: MessageCodec): () => void; get(kind: string): MessageCodec | undefined; validate(kind: string, payload: unknown): void }
export interface SdkOptions {
  user: User; token: string; websocketUrl: string; api: ApiPort; transport: TransportPort;
  storage: StoragePort; timers: TimerPort; plugins: PluginRegistry; logger?: LoggerPort;
  heartbeatMs?: number; maxQueue?: number; maxInFlight?: number; maxResidentMessages?: number;
}
export type SdkEvent =
 | { type: "state"; state: ConnectionState }
 | { type: "conversation"; conversation: Conversation }
 | { type: "message"; message: Message }
 | { type: "receipt"; conversationId: string; userId: string; seq: number }
 | { type: "error"; code: string; message: string };
