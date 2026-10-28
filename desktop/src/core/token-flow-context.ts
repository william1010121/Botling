import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./durable/atomic";
import { z } from "zod";
const context = z.strictObject({ taskId:z.string().nullable(), appTurnId:z.string() });
type Context = z.infer<typeof context>;
/** App-dispatch receipts, persisted before worker usage. No prompts or inferred names. */
export class TokenFlowContexts {
  private contexts: Record<string, Context> = {};
  unreadable = false;
  constructor(private file: string) {
    try { this.contexts = z.record(z.string(),context).parse(JSON.parse(readFileSync(file,"utf8"))); }
    catch(e) { this.unreadable = (e as NodeJS.ErrnoException).code !== "ENOENT"; }
  }
  get(head:string, worker:string) { return this.contexts[JSON.stringify([head,worker])]; }
  bind(head:string, worker:string, value:Context) {
    if (this.unreadable) return;
    const key=JSON.stringify([head,worker]);
    if (this.contexts[key]) return; // A replay cannot steal an existing dispatch.
    const next={...this.contexts,[key]:value};
    try { writeFileAtomic(this.file,JSON.stringify(next));this.contexts=next; } catch {this.unreadable=true;}
  }
}

const books = new Map<string,TokenFlowContexts>();
export function tokenFlowContexts(file:string) {
  let book=books.get(file);
  if(!book){book=new TokenFlowContexts(file);if(books.size>=8)books.delete(books.keys().next().value!);books.set(file,book);}
  return book;
}
