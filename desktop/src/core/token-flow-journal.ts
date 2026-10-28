import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./durable/atomic";

export const TOKEN_SEGMENT_BYTES=16*1024*1024;
const manifestSchema=z.strictObject({version:z.literal(1),generation:z.string().uuid(),parts:z.array(z.strictObject({bytes:z.number().int().positive(),sha256:z.string().regex(/^[0-9a-f]{64}$/)}))});
type Manifest=z.infer<typeof manifestSchema>;
/** Single writer under the existing profile lock. The manifest is the only commit point.
 * Each snapshot/journal is bounded; total retained history and its in-memory identity map
 * grow with unique measurements. No identity eviction or configured total-history ceiling. */
export class TokenFlowJournal {
  private manifest:Manifest|null=null;
  private active:string;
  private bytes=0;
  readonly manifestFile:string;
  constructor(readonly file:string,readonly segmentBytes=TOKEN_SEGMENT_BYTES){
    if(!Number.isSafeInteger(segmentBytes)||segmentBytes<512)throw Error("Invalid token segment bound");
    this.active=file;this.manifestFile=`${file}.manifest.json`;
  }
  private name(generation:string,part:number|"journal") {return join(dirname(this.file),`${basename(this.file)}.g-${generation}.${part}.jsonl`);}
  private read(file:string,consume:(line:string)=>void,expected?:Manifest["parts"][number]) {
    if(statSync(file).size>this.segmentBytes)throw Error("Token segment exceeds its byte bound");
    const raw=readFileSync(file);
    if(expected&&(raw.length!==expected.bytes||createHash("sha256").update(raw).digest("hex")!==expected.sha256))throw Error("Token snapshot integrity check failed");
    const content=raw.toString("utf8");
    if(content&&!content.endsWith("\n"))throw Error("Torn token journal tail");
    for(const line of content.split("\n"))if(line)consume(line);
    return raw.length;
  }
  load(consume:(line:string)=>void) {
    let saved:string;
    try{saved=readFileSync(this.manifestFile,"utf8");}
    catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;
      // Never silently fall back to old data when a generation manifest is lost.
      // Interrupted first publication also fails closed, preserving recovery evidence.
      let files:string[]=[];
      try{files=readdirSync(dirname(this.file));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
      if(files.some(name=>name.startsWith(`${basename(this.file)}.g-`)))throw Error("Missing token generation manifest");
      // A legacy journal is retained as-is until the first successful generation switch.
      try{this.bytes=this.read(this.file,consume);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
      return;
    }
    this.manifest=manifestSchema.parse(JSON.parse(saved));
    this.manifest.parts.forEach((part,i)=>this.read(this.name(this.manifest!.generation,i),consume,part));
    this.active=this.name(this.manifest.generation,"journal");
    // Missing referenced files are corruption, never an empty/new ledger.
    this.bytes=this.read(this.active,consume);
  }
  append(line:string,snapshots:()=>Iterable<string>) {
    const size=Buffer.byteLength(line);
    if(size>this.segmentBytes)throw Error("Token measurement exceeds segment byte bound");
    if(this.bytes+size>this.segmentBytes)this.compact(snapshots());
    mkdirSync(dirname(this.file),{recursive:true});
    const fd=openSync(this.active,"a",0o600);
    try{appendFileSync(fd,line);fsyncSync(fd);}finally{closeSync(fd);}
    this.bytes+=size;
  }
  private compact(records:Iterable<string>) {
    const next:Manifest={version:1,generation:randomUUID(),parts:[]};
    let lines:string[]=[],bytes=0;
    const flush=()=>{
      if(!bytes)return;
      const text=lines.join("");
      writeFileAtomic(this.name(next.generation,next.parts.length),text);
      next.parts.push({bytes,sha256:createHash("sha256").update(text).digest("hex")});
      lines=[];bytes=0;
    };
    for(const line of records){
      const size=Buffer.byteLength(line);
      if(size>this.segmentBytes)throw Error("Token snapshot record exceeds segment byte bound");
      if(bytes+size>this.segmentBytes)flush();
      lines.push(line);bytes+=size;
    }
    flush();
    const journal=this.name(next.generation,"journal");
    writeFileAtomic(journal,"");
    // All new files are durable before publication. Failure before this leaves the old
    // manifest authoritative; after it, startup sees the full new snapshot + new journal.
    writeFileAtomic(this.manifestFile,JSON.stringify(next));
    this.manifest=next;this.active=journal;this.bytes=0;
    // Sweep only this ledger's unreferenced generation files, including abandoned
    // pre-publication generations from an earlier failed compaction. No legacy deletion.
    const keep=new Set([...next.parts.map((_,i)=>basename(this.name(next.generation,i))),basename(journal)]);
    const prefix=`${basename(this.file)}.g-`;
    try{for(const name of readdirSync(dirname(this.file))){
      if(name.startsWith(prefix)&&/^[0-9a-f-]{36}\.(?:journal|[0-9]+)\.jsonl$/.test(name.slice(prefix.length))&&!keep.has(name)){
        try{rmSync(join(dirname(this.file),name),{force:true});}catch{/* Cleanup cannot invalidate publication. */}
      }
    }}catch{/* Directory cleanup is best effort; manifest references remain authoritative. */}
  }
}
