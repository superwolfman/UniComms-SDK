import test from "node:test";
import assert from "node:assert/strict";
import { UniCommsClient, createDefaultPlugins } from "../dist/index.js";

class FakeSocket {
  readyState = 1; onopen = null; onmessage = null; onerror = null; onclose = null;
  constructor() { queueMicrotask(() => this.onopen?.()); }
  send(raw) {
    const frame = JSON.parse(raw);
    queueMicrotask(() => this.onmessage?.(JSON.stringify({ v: 1, requestId: frame.requestId, type: frame.type === "auth" ? "ready" : frame.type === "message.send" ? "ack" : "pong", payload: frame.type === "auth" ? { heartbeatMs: 15000 } : frame.type === "message.send" ? { id: "server-message", conversationId: frame.payload.conversationId, senderId: "user-1", clientMessageId: frame.payload.clientMessageId, seq: 1, kind: frame.payload.kind, payload: frame.payload.payload, createdAt: 10 } : {} })));
  }
  close() { this.readyState = 3; this.onclose?.(); }
}
const timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: id => clearInterval(id),
  now: () => 10, uuid: (() => { let n = 0; return () => `uuid-${++n}`; })(), random: () => 0.5,
};

test("durable send persists first and removes outbox after server ack", async () => {
  const persisted = []; const snapshots = new Map(); let savedOutbox = [];
  const storage = {
    loadSnapshot: async id => snapshots.get(id) ?? { cursor: 0, messages: [] },
    saveSnapshot: async (id, snapshot) => snapshots.set(id, structuredClone(snapshot)),
    loadOutbox: async () => savedOutbox,
    saveOutbox: async value => { savedOutbox = structuredClone(value); persisted.push(savedOutbox.length); },
  };
  const client = new UniCommsClient({ user: { id: "user-1", tenant: "test", username: "alice", displayName: "Alice" }, token: "x".repeat(40), websocketUrl: "ws://local/ws", api: { conversations: async () => [], history: async () => ({ items: [], nextCursor: 0, hasMore: false }), historyBefore: async () => ({ items: [], nextCursor: 0, hasMore: false }), send: async () => { throw new Error("not used"); }, markRead: async () => undefined }, transport: { connect: () => new FakeSocket() }, storage, timers, plugins: createDefaultPlugins() });
  const online = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("online timeout")), 1500); client.subscribe(event => { if (event.type === "state" && event.state === "online") { clearTimeout(timer); resolve(); } }); });
  await client.connect(); await online;
  await client.send("conversation-1", "text", { text: "Hello" });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("ack timeout")), 1500); const poll = setInterval(() => { if (savedOutbox.length === 0 && snapshots.get("conversation-1")?.messages[0]?.seq === 1) { clearTimeout(timer); clearInterval(poll); resolve(); } }, 5); });
  assert.ok(persisted.includes(1), "outbox is committed before network delivery");
  assert.equal(savedOutbox.length, 0);
  assert.equal(snapshots.get("conversation-1").messages[0].seq, 1);
  await client.close();
});

test("default codecs reject unsafe media URLs and invalid message kinds", () => {
  const plugins = createDefaultPlugins();
  assert.throws(() => plugins.validate("image", { url: "http://example.com/image.png", alt: "sample" }));
  assert.throws(() => plugins.validate("unknown", {}));
  assert.doesNotThrow(() => plugins.validate("text", { text: "hello" }));
});
