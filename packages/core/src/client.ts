import type { ApiPort, ConnectionState, LoggerPort, Message, MessagePage, RemoteMessage, SdkEvent, SdkOptions, SocketFrame, SocketPort, Snapshot } from "./types.js";

const NOOP: LoggerPort = {debug:()=>undefined,warn:()=>undefined};
const DEFAULTS = {heartbeatMs:15000,maxQueue:1000,maxInFlight:32,maxResidentMessages:1000};
class RemoteRequestError extends Error { constructor(message:string,readonly retryable:boolean){super(message);this.name="RemoteRequestError";} }
export class UniCommsClient {
  private state: ConnectionState = "idle";
  private socket: SocketPort | null = null;
  private generation = 0;
  private reconnectTimer: unknown;
  private heartbeatTimer: unknown;
  private watchdogTimer: unknown;
  private retryAttempt = 0;
  private reconnectEnabled = false;
  private readonly listeners = new Set<(event: SdkEvent) => void>();
  private readonly ready = new Map<string,(frame:SocketFrame)=>void>();
  private readonly snapshots = new Map<string,Snapshot>();
  private readonly syncing = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly options: SdkOptions & typeof DEFAULTS;
  private outbox: Message[] = [];
  private startPromise: Promise<void> | null = null;
  private outboxWrite: Promise<void> = Promise.resolve();
  private syncWrite: Promise<void> = Promise.resolve();

  constructor(options: SdkOptions) {
    this.options={...DEFAULTS,...options};
    if(options.token.length<20) throw new Error("Session token is missing");
  }
  get connectionState(): ConnectionState {return this.state;}
  get conversationsSnapshot(): ConversationView[] {return [...this.snapshots.entries()].map(([id,s])=>({id,cursor:s.cursor,messages:s.messages}));}
  subscribe(listener:(event:SdkEvent)=>void):()=>void {this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  private emit(event:SdkEvent):void {for(const listener of this.listeners) try{listener(event);}catch(e){this.logger.warn("SDK subscriber threw",{error:e instanceof Error?e.message:"unknown"});}}
  private get logger():LoggerPort {return this.options.logger??NOOP;}
  private transition(next:ConnectionState):void {if(next===this.state)return;this.state=next;this.emit({type:"state",state:next});}
  async connect():Promise<void> {
    if(this.state==="closed")throw new Error("Client is closed");
    this.reconnectEnabled=true;
    if(this.startPromise)return this.startPromise;
    this.startPromise=this.loadAndConnect().finally(()=>{this.startPromise=null;});return this.startPromise;
  }
  private async loadAndConnect():Promise<void> {
    this.outbox=await this.options.storage.loadOutbox();
    this.transition("connecting");this.openSocket();
  }
  private openSocket():void {
    if(!this.reconnectEnabled||this.state==="closed")return;
    const id=++this.generation;this.transition("connecting");
    let socket:SocketPort;
    try{socket=this.options.transport.connect(this.options.websocketUrl);}catch(e){this.scheduleReconnect();return;}
    this.socket=socket;
    socket.onopen=()=>{if(id!==this.generation)return;this.transition("authenticating");this.request(socket,"auth",{token:this.options.token}).then(f=>{if(id===this.generation&&f.type==="ready")void this.onReady(id);}).catch(e=>{this.protocolError(e);socket.close(4001);});};
    socket.onmessage=(raw)=>{if(id!==this.generation)return;void this.onFrame(raw);};
    socket.onerror=()=>this.logger.warn("WebSocket transport error");
    socket.onclose=()=>{if(id!==this.generation)return;this.clearConnectionTimers();this.socket=null;if(this.reconnectEnabled){this.transition("backoff");this.scheduleReconnect();}else this.transition("closed");};
  }
  private async onReady(id:number):Promise<void>{
    this.retryAttempt=0;this.transition("syncing");this.clearConnectionTimers();
    this.heartbeatTimer=this.options.timers.setInterval(()=>{if(this.socket?.readyState===1)this.socket.send(this.frame("ping",{}));},this.options.heartbeatMs);
    this.watchdogTimer=this.options.timers.setInterval(()=>this.retryStalled(),5000);
    try{
      const conversations=await this.options.api.conversations();if(id!==this.generation)return;
      for(const c of conversations){this.emit({type:"conversation",conversation:c});await this.sync(c.id);}
      if(id!==this.generation)return;
      this.transition("online");await this.flush();
    }catch(e){this.logger.warn("Initial sync failed",{error:e instanceof Error?e.message:"unknown"});this.transition("backoff");this.socket?.close(1011);}
  }
  private async onFrame(raw:string):Promise<void>{
    let f:SocketFrame;
    try{const v:unknown=JSON.parse(raw);if(!this.isFrame(v))throw new Error("Invalid WebSocket frame");f=v;}
    catch(e){this.protocolError(e);return;}
    if(f.type==="pong")return;
    if(f.type==="ack"){
      const message=this.remoteMessage(f.payload);if(!message){this.protocolError(new Error("Invalid message ack"));return;}
      const handler=this.ready.get(f.requestId);if(handler){this.ready.delete(f.requestId);handler(f);return;}
      this.inFlight.delete(message.clientMessageId);await this.applyRemote(message);await this.removeOutbox(message.clientMessageId);void this.flush();return;
    }
    if(f.type==="event"){
      const p=f.payload;if(!this.object(p)||typeof p.conversationId!=="string")return;
      if(p.eventType==="message.created"){const message=this.remoteMessage(p.data);if(message)await this.applyRemote(message);}
      else if(p.eventType==="receipt"&&this.object(p.data)&&typeof p.data.userId==="string"&&typeof p.data.seq==="number")this.emit({type:"receipt",conversationId:p.conversationId,userId:p.data.userId,seq:p.data.seq});
      void this.sync(p.conversationId);return;
    }
    if(f.type==="error"){
      const request=f.requestId?this.ready.get(f.requestId):undefined;
      if(request){this.ready.delete(f.requestId);request(f);}
      const payload=f.payload;this.emit({type:"error",code:this.object(payload)&&typeof payload.code==="string"?payload.code:"PROTOCOL_ERROR",message:this.object(payload)&&typeof payload.message==="string"?payload.message:"Request failed"});return;
    }
    const handler=this.ready.get(f.requestId);if(handler){this.ready.delete(f.requestId);handler(f);}
  }
  async send(conversationId:string,kind:string,payload:unknown):Promise<Message>{
    if(this.state==="closed")throw new Error("Client is closed");
    this.options.plugins.validate(kind,payload);
    if(this.outbox.length>=this.options.maxQueue)throw new Error("Offline message queue is full");
    const message:Message={id:this.options.timers.uuid(),conversationId,senderId:this.options.user.id,clientMessageId:this.options.timers.uuid(),seq:0,kind,payload,createdAt:this.options.timers.now(),delivery:"queued"};
    this.outbox.push(message);await this.persistOutbox();await this.applyLocal(message);void this.flush();return message;
  }
  async retry(clientMessageId:string):Promise<void>{const m=this.outbox.find(x=>x.clientMessageId===clientMessageId);if(m){this.inFlight.delete(clientMessageId);m.delivery="queued";await this.persistOutbox();void this.flush();}}
  async loadOlder(conversationId:string,limit=50):Promise<Message[]>{
    const snapshot=await this.snapshot(conversationId);const oldest=snapshot.messages.reduce((v,m)=>m.seq>0?Math.min(v,m.seq):v,Number.MAX_SAFE_INTEGER);
    if(oldest===Number.MAX_SAFE_INTEGER||oldest<=1)return [];
    const page=await this.options.api.historyBefore(conversationId,oldest,limit);
    for(const r of page.items)await this.applyRemote(r,false);
    return page.items.map(m=>this.asMessage(m,"sent"));
  }
  async markRead(conversationId:string,seq:number):Promise<void>{await this.options.api.markRead(conversationId,seq);}
  async disconnect():Promise<void>{
    this.reconnectEnabled=false;this.generation++;this.clearConnectionTimers();
    if(this.reconnectTimer!==undefined)this.options.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer=undefined;this.ready.clear();this.socket?.close(1000);this.socket=null;this.inFlight.clear();
    if(this.state!=="closed")this.transition("idle");
  }
  async close():Promise<void>{await this.disconnect();this.transition("closed");}
  private async sync(conversationId:string):Promise<void>{
    if(this.syncing.has(conversationId)||!this.reconnectEnabled)return;
    this.syncing.add(conversationId);
    try{
      const snapshot=await this.snapshot(conversationId);let cursor=snapshot.cursor;let rounds=0;
      while(rounds++<100){const page=await this.options.api.history(conversationId,cursor,200);if(page.items.length===0)break;
        for(const r of page.items){await this.applyRemote(r,false);cursor=Math.max(cursor,r.seq);}
        const next=await this.snapshot(conversationId);next.cursor=cursor;await this.saveSnapshot(conversationId,next);
        if(!page.hasMore)break;
      }
    }catch(e){this.logger.warn("History sync failed",{conversationId,error:e instanceof Error?e.message:"unknown"});}
    finally{this.syncing.delete(conversationId);}
  }
  private async applyLocal(m:Message):Promise<void>{const s=await this.snapshot(m.conversationId);if(!s.messages.some(x=>x.clientMessageId===m.clientMessageId))s.messages.push(m);this.trim(s);await this.saveSnapshot(m.conversationId,s);this.emit({type:"message",message:m});}
  private async applyRemote(r:RemoteMessage,advance=true):Promise<void>{
    const m=this.asMessage(r,"sent");const s=await this.snapshot(m.conversationId);
    const i=s.messages.findIndex(x=>x.id===m.id||x.clientMessageId===m.clientMessageId);
    if(i>=0)s.messages[i]=m;else s.messages.push(m);
    s.messages.sort((a,b)=>a.seq===0?1:b.seq===0?-1:a.seq-b.seq);if(advance)s.cursor=Math.max(s.cursor,m.seq);this.trim(s);await this.saveSnapshot(m.conversationId,s);this.emit({type:"message",message:m});
  }
  private trim(s:Snapshot):void {if(s.messages.length>this.options.maxResidentMessages)s.messages.splice(0,s.messages.length-this.options.maxResidentMessages);}
  private async snapshot(id:string):Promise<Snapshot>{let s=this.snapshots.get(id);if(!s){s=await this.options.storage.loadSnapshot(id);this.snapshots.set(id,s);}return s;}
  private saveSnapshot(id:string,s:Snapshot):Promise<void>{this.syncWrite=this.syncWrite.then(async()=>{await this.options.storage.saveSnapshot(id,s);});return this.syncWrite;}
  private persistOutbox():Promise<void>{this.outboxWrite=this.outboxWrite.then(()=>this.options.storage.saveOutbox([...this.outbox]));return this.outboxWrite;}
  private async removeOutbox(clientMessageId:string):Promise<void>{this.outbox=this.outbox.filter(m=>m.clientMessageId!==clientMessageId);this.inFlight.delete(clientMessageId);await this.persistOutbox();}
  private async flush():Promise<void>{
    const socket=this.socket;if(this.state!=="online"||!socket||socket.readyState!==1)return;
    for(const m of this.outbox){if(this.inFlight.size>=this.options.maxInFlight)break;if(this.inFlight.has(m.clientMessageId)||m.delivery==="failed")continue;
      m.delivery="sending";this.inFlight.add(m.clientMessageId);await this.persistOutbox();
      try{const f=await this.request(socket,"message.send",{conversationId:m.conversationId,clientMessageId:m.clientMessageId,kind:m.kind,payload:m.payload});
        if(f.type==="error"){m.delivery="queued";}
        else {const remote=this.remoteMessage(f.payload);if(remote){await this.applyRemote(remote);await this.removeOutbox(m.clientMessageId);}}
      }catch(error){
        this.inFlight.delete(m.clientMessageId);
        if(error instanceof RemoteRequestError&&!error.retryable){m.delivery="failed";this.emit({type:"error",code:"SEND_REJECTED",message:error.message});await this.persistOutbox();continue;}
        m.delivery="queued";if(this.socket===socket)socket.close(1011);break;
      }
      await this.persistOutbox();
    }
  }
  private retryStalled():void{for(const id of this.inFlight){this.inFlight.delete(id);const m=this.outbox.find(x=>x.clientMessageId===id);if(m)m.delivery="queued";}void this.persistOutbox().then(()=>this.flush());}
  private request(socket:SocketPort,type:string,payload:unknown):Promise<SocketFrame>{
    const requestId=this.options.timers.uuid();return new Promise((resolve,reject)=>{
      const timer=this.options.timers.setTimeout(()=>{this.ready.delete(requestId);reject(new Error(`${type} acknowledgement timeout`));},8000);
      this.ready.set(requestId,f=>{this.options.timers.clearTimeout(timer);if(f.type==="error"){const p=f.payload;reject(new RemoteRequestError(this.object(p)&&typeof p.message==="string"?p.message:"Server rejected request",this.object(p)&&p.retryable===true));}else resolve(f);});
      try{socket.send(JSON.stringify({v:1,type,requestId,payload}));}catch(e){this.ready.delete(requestId);this.options.timers.clearTimeout(timer);reject(e);}
    });
  }
  private frame(type:string,payload:unknown):string{return JSON.stringify({v:1,type,requestId:this.options.timers.uuid(),payload});}
  private scheduleReconnect():void {
    if(!this.reconnectEnabled||this.reconnectTimer!==undefined)return;
    const base=Math.min(30000,500*Math.pow(2,Math.min(this.retryAttempt++,6)));const delay=Math.floor(base*(0.75+this.options.timers.random()*0.5));
    this.transition("backoff");this.reconnectTimer=this.options.timers.setTimeout(()=>{this.reconnectTimer=undefined;this.openSocket();},delay);
  }
  private clearConnectionTimers():void{for(const id of [this.heartbeatTimer,this.watchdogTimer])if(id!==undefined)this.options.timers.clearInterval(id);this.heartbeatTimer=undefined;this.watchdogTimer=undefined;}
  private protocolError(e:unknown):void{this.logger.warn("Malformed or failed protocol operation",{error:e instanceof Error?e.message:"unknown"});this.emit({type:"error",code:"PROTOCOL_ERROR",message:"The server response could not be processed"});}
  private asMessage(r:RemoteMessage,delivery:Message["delivery"]):Message{return{...r,delivery};}
  private remoteMessage(p:unknown):RemoteMessage|null {if(!this.object(p)||typeof p.id!=="string"||typeof p.conversationId!=="string"||typeof p.senderId!=="string"||typeof p.clientMessageId!=="string"||typeof p.seq!=="number"||!Number.isSafeInteger(p.seq)||typeof p.kind!=="string"||typeof p.createdAt!=="number"||!("payload" in p))return null;return p as unknown as RemoteMessage;}
  private object(v:unknown):v is Record<string,unknown>{return typeof v==="object"&&v!==null&&!Array.isArray(v);}
  private isFrame(v:unknown):v is SocketFrame {return this.object(v)&&v.v===1&&typeof v.type==="string"&&typeof v.requestId==="string"&&"payload" in v;}
}
export interface ConversationView {id:string;cursor:number;messages:Message[]}
