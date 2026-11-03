import type { MessageCodec, PluginRegistry } from "./types.js";

export class DefaultPluginRegistry implements PluginRegistry {
  private readonly codecs = new Map<string, MessageCodec>();
  register(codec: MessageCodec): () => void {
    if (!/^[a-z][a-z0-9.-]{0,31}$/.test(codec.kind)) throw new Error("Message plugin kind is invalid");
    if (this.codecs.has(codec.kind)) throw new Error(`Message plugin '${codec.kind}' is already registered`);
    this.codecs.set(codec.kind, codec);
    return () => { if (this.codecs.get(codec.kind) === codec) this.codecs.delete(codec.kind); };
  }
  get(kind: string): MessageCodec | undefined { return this.codecs.get(kind); }
  validate(kind: string, payload: unknown): void {
    const codec = this.codecs.get(kind);
    if (!codec) throw new Error(`Unsupported message type '${kind}'`);
    if (!codec.validate(payload)) throw new Error(`Invalid '${kind}' payload`);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const shortText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const secureUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 2048) return false;
  try { return new URL(value).protocol === "https:" && new URL(value).username === "" && new URL(value).password === ""; }
  catch { return false; }
};
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every(key => allowed.includes(key));

export const createDefaultPlugins = (): DefaultPluginRegistry => {
  const registry = new DefaultPluginRegistry();
  registry.register({kind:"text",validate:(p):p is {text:string} => isObject(p)&&exactKeys(p,["text"])&&shortText(p.text,4000)});
  registry.register({kind:"image",validate:(p):p is {url:string;alt:string} => isObject(p)&&exactKeys(p,["url","alt"])&&secureUrl(p.url)&&shortText(p.alt,200)});
  registry.register({kind:"audio",validate:(p):p is {url:string;duration:number} => isObject(p)&&exactKeys(p,["url","duration"])&&secureUrl(p.url)&&typeof p.duration==="number"&&Number.isFinite(p.duration)&&p.duration>=0&&p.duration<=3600});
  registry.register({kind:"location",validate:(p):p is {latitude:number;longitude:number;label:string} => isObject(p)&&exactKeys(p,["latitude","longitude","label"])&&typeof p.latitude==="number"&&Number.isFinite(p.latitude)&&Math.abs(p.latitude)<=90&&typeof p.longitude==="number"&&Number.isFinite(p.longitude)&&Math.abs(p.longitude)<=180&&shortText(p.label,200)});
  return registry;
};
