import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { Conversation, Message, SdkEvent } from "@unicomms/core";
import type { UniCommsClient } from "@unicomms/core";

export interface ChatPanelProps { client: UniCommsClient; conversations: Conversation[]; currentUserId: string; onSelectConversation?: (id: string) => void }
export function ChatPanel({ client, conversations, currentUserId, onSelectConversation }: ChatPanelProps) {
  const [events, setEvents] = useState<SdkEvent[]>([]); const [active, setActive] = useState(conversations[0]?.id ?? ""); const [draft, setDraft] = useState("");
  const conversation = conversations.find(item => item.id === active); const messages = useMemo(() => client.conversationsSnapshot.find(item => item.id === active)?.messages ?? [], [client, events, active]);
  useEffect(() => client.subscribe(event => setEvents(previous => [...previous.slice(-199), event])), [client]);
  useEffect(() => { if (!active && conversations[0]) setActive(conversations[0].id); }, [active, conversations]);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!active || !draft.trim()) return; await client.send(active, "text", { text: draft.trim() }); setDraft(""); }
  return <section className="uc-chat" aria-label="UniComms chat">
    <aside className="uc-sidebar"><div className="uc-brand"><span className="uc-mark">U</span><div><strong>UniComms</strong><small>Messaging workspace</small></div></div><p className="uc-label">CONVERSATIONS</p>
      {conversations.map(item => <button className={`uc-conversation ${active === item.id ? "is-active" : ""}`} key={item.id} onClick={() => { setActive(item.id); onSelectConversation?.(item.id); }}><span className="uc-avatar">{item.title.slice(0, 1).toUpperCase()}</span><span className="uc-conversation-copy"><strong>{item.title}</strong><small>{item.memberIds.length} members</small></span><span className="uc-dot" /></button>)}
      {!conversations.length && <div className="uc-empty">No conversations yet</div>}
      <div className="uc-sidebar-footer"><span className="uc-online-dot" /> Connected SDK session</div>
    </aside>
    <main className="uc-main"><header className="uc-header"><div><p className="uc-label">DIRECT MESSAGES</p><h1>{conversation?.title ?? "Choose a conversation"}</h1></div><div className="uc-header-state"><span className="uc-online-dot" />Live sync</div></header>
      <div className="uc-messages" role="log" aria-live="polite">{messages.map(message => <MessageBubble key={message.clientMessageId} message={message} mine={message.senderId === currentUserId} />)}{!messages.length && <div className="uc-empty-state"><span>✳</span><strong>Your conversation starts here</strong><p>Messages are synced through the shared IMSDK Core.</p></div>}</div>
      <form className="uc-composer" onSubmit={submit}><label className="uc-sr-only" htmlFor="uc-message">Write a message</label><input id="uc-message" value={draft} onChange={event => setDraft(event.target.value)} placeholder="Message this conversation…" maxLength={4000} disabled={!active} /><button disabled={!active || !draft.trim()} aria-label="Send message">Send <span>↗</span></button><small>Enter to send · messages are durably queued</small></form>
    </main>
  </section>;
}
function MessageBubble({ message, mine }: { message: Message; mine: boolean }) {
  const body = message.kind === "text" && typeof message.payload === "object" && message.payload !== null && "text" in message.payload ? String(message.payload.text) : `[${message.kind} message]`;
  return <article className={`uc-message ${mine ? "is-mine" : ""}`}><div className="uc-message-meta">{mine ? "You" : message.senderId.slice(0, 8)} <span>#{message.seq || "queued"}</span></div><div className="uc-bubble">{body}</div><small className="uc-delivery">{message.delivery === "queued" ? "Queued offline" : message.delivery === "failed" ? "Failed · retry from SDK" : message.delivery}</small></article>;
}
