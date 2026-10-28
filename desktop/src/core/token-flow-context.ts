import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./durable/atomic";
import { z } from "zod";
const identity=z.string().min(1).max(200);
const context = z.strictObject({ taskId:identity.nullable(), appTurnId:identity });
type Context = z.infer<typeof context>;
const receiptMap=z.record(z.string(),context);
const state=z.strictObject({version:z.literal(2),receipts:receiptMap,aliases:z.record(identity,identity)});
/** Run-scoped app-dispatch receipts. Old unscoped receipts are not evidence for a new Codex run. */
export class TokenFlowContexts {
  private contexts: Record<string, Context> = {};
  private aliases: Record<string,string> = {};
  unreadable = false;
  aliasRevision = 0;
  constructor(private file: string) {
    try {
      const raw=JSON.parse(readFileSync(file,"utf8"));
      if(raw.version===2){const saved=state.parse(raw);this.contexts=saved.receipts;this.aliases=saved.aliases;}
      else this.contexts=receiptMap.parse(raw);
      for(const id of Object.keys(this.aliases))this.canonical(id);
    } catch(e) { this.unreadable = (e as NodeJS.ErrnoException).code !== "ENOENT"; }
  }
  canonical(taskId:string|null):string|null {
    let id=taskId;const seen=new Set<string>();
    while(id&&this.aliases[id]){if(seen.has(id)){this.unreadable=true;throw Error("Cyclic token task aliases");}seen.add(id);id=this.aliases[id];}
    return id;
  }
  get(head:string, worker:string, run:number|null=null) {
    const key=JSON.stringify(run===null?[head,worker]:[head,worker,run]);
    const value=this.contexts[key];
    return value?{...value,taskId:this.canonical(value.taskId)}:undefined;
  }
  bind(head:string, worker:string, value:Context, run:number|null=null) {
    if (this.unreadable || !context.safeParse(value).success || (run!==null&&(!Number.isSafeInteger(run)||run<1))) return;
    const key=JSON.stringify(run===null?[head,worker]:[head,worker,run]);
    if (this.contexts[key]) return; // Same dispatch/run replay cannot steal its owner.
    this.save({...this.contexts,[key]:{...value,taskId:this.canonical(value.taskId)}},this.aliases);
  }
  /** Called only by TaskBook's actual merge observer, never by matching task names. */
  mergeTask(from:string,into:string) {
    if(this.unreadable||!identity.safeParse(from).success||!identity.safeParse(into).success)return;
    const target=this.canonical(into)!;
    if(from===target)return;
    const aliases={...this.aliases,[from]:target};
    const receipts=Object.fromEntries(Object.entries(this.contexts).map(([key,value])=>[key,
      this.canonical(value.taskId)===from?{...value,taskId:target}:value]));
    this.save(receipts,aliases);
  }
  private save(receipts:Record<string,Context>,aliases:Record<string,string>) {
    try{writeFileAtomic(this.file,JSON.stringify({version:2,receipts,aliases}));if(aliases!==this.aliases)this.aliasRevision++;this.contexts=receipts;this.aliases=aliases;}
    catch{this.unreadable=true;}
  }
}
const books = new Map<string,TokenFlowContexts>();
export function tokenFlowContexts(file:string) {
  let book=books.get(file);
  if(!book){book=new TokenFlowContexts(file);if(books.size>=8)books.delete(books.keys().next().value!);books.set(file,book);}
  return book;
}
