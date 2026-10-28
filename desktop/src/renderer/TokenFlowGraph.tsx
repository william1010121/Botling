import { useEffect, useMemo, useRef, useState } from "react";
import type { TokenFlowHistoryView } from "../contract";
import { measuredAmount, taskFlowGroups, agentKey, agentLabel, type MeasurementGroup } from "./token-flow-graph-model";
import { flowCount } from "./token-flow-model";

const exact = (n: number) => n.toLocaleString();
/** Fixed semantic columns, collapsible task containers and path selection. Edge widths are
 * deliberately constant: topology is not an allocation of inclusive parent counters. */
export function TokenFlowGraph({ name, rows, tasks, workers }: { name: string; rows: MeasurementGroup[]; tasks: TokenFlowHistoryView["tasks"]; workers: TokenFlowHistoryView["rows"] }) {
  const agents = [...new Set(rows.map(agentKey))].sort();
  const groups = useMemo(() => taskFlowGroups(rows, tasks), [rows, tasks]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const detail=groups.flatMap(g=>g.rows).find(r=>r.id===detailId)??null;
  const viewport = useRef<HTMLDivElement>(null);
  const evidence=useRef<HTMLElement>(null);
  useEffect(()=>{if(detailId)evidence.current?.scrollIntoView?.({block:"nearest"});},[detailId]);
  const total = groups.reduce((n,g) => n+g.total,0), measured = groups.reduce((n,g) => n+g.measured,0);
  const missing = groups.reduce((n,g) => n+g.missing,0), partial = groups.reduce((n,g) => n+g.partial,0);
  const unresolved=groups.filter(g=>g.id==="unresolved").reduce((n,g)=>n+g.rows.reduce((a,r)=>a+r.turns,0),0);
  const historical=groups.filter(g=>g.coverage&&g.id!=="unresolved").reduce((n,g)=>n+g.total,0);
  let top = 54;
  const positions = groups.map(group => { const y=top; const height=114+(expanded.has(group.id)?group.rows.length*74:0); top+=height+24;return {group,y,height}; });
  const height = Math.max(180+agents.length*126,top);
  const related = (id:string, agent?:string) => !selected || selected===id || selected===agent || groups.find(g=>g.id===id)?.rows.some(r=>agentKey(r)===selected);
  const title = (r: MeasurementGroup) => workers.find(w=>w.id===r.workerId&&w.head===r.head)?.title ?? (r.id.startsWith("other-") ? "Other retained measurements" : r.workerId ? "Subagent" : r.attribution==="chat" ? "Chat coordinator" : "Coordinator");
  return <div className="tf-topology">
    <div className="tf-topology-tools"><span>Recorded tokens · {measured} measurements{partial>0?` · ${partial} partial`:""}{missing>0?` · ${missing} usage unknown`:""}</span>
      <div>{["Project","Tasks / chat","Agents"].map((label,i)=><button key={label} onClick={()=>viewport.current?.scrollTo({left:[0,348,700][i],top:0})}>{label}</button>)}<button onClick={()=>{setSelected(null);setDetailId(null);setExpanded(new Set());}}>Collapse all</button></div>
    </div>
    {(historical>0||unresolved>0)&&<p className="tf-topology-note">{historical>0?`${exact(historical)} tokens retain earlier / aggregate attribution. `:""}{unresolved>0?`${unresolved} ${unresolved===1?"measurement lacks":"measurements lack"} an app dispatch receipt; expand Missing dispatch context for thread evidence.`:""}</p>}
    <p className="tf-topology-note">Lines show recorded relationships, not token volume. Totals count each measurement once. Project → task or chat → agent. Earlier records and missing dispatch context remain visible for reconciliation.</p>
    <div className="tf-topology-viewport" ref={viewport} tabIndex={0} aria-label="Task-linked token graph" onKeyDown={e=>{if(e.key==="Escape"){setSelected(null);setDetailId(null);}}}>
      <div className="tf-topology-stage" style={{height}}>
        <div className="tf-topology-label" style={{left:24}}>PROJECT</div><div className="tf-topology-label" style={{left:348}}>TASKS / CHAT</div><div className="tf-topology-label" style={{left:738}}>AGENTS</div>
        <svg className="tf-topology-lines" width="1010" height={height} aria-label="Recorded relationships">
          {positions.map(({group,y})=><path key={group.id} data-related={related(group.id)} d={`M274 126 C310 126 310 ${y+50} 348 ${y+50}`}><title>{group.name}: {group.measured?exact(group.total):"Unknown"} recorded tokens</title></path>)}
          {positions.flatMap(({group,y})=>agents.flatMap((agent,i)=>{
            const portion=group.rows.filter(r=>agentKey(r)===agent);if(!portion.length)return [];
            return <path key={`${group.id}:${agent}`} data-related={!selected||selected===group.id||selected===agent} d={`M678 ${y+50} C708 ${y+50} 708 ${105+i*126} 738 ${105+i*126}`}><title>{group.name} → {agentLabel(agent)}: {portion.some(r=>r.turns>(r.missing??0))?exact(portion.reduce((n,r)=>n+measuredAmount(r),0)):"Unknown"} recorded tokens</title></path>;
          }))}
        </svg>
        <article className="tf-topology-root" style={{left:24,top:54}}><small>EXCLUSIVE RECORDED TOTAL</small><h3>{name}</h3><strong title={measured?`${exact(total)} tokens`:"Usage unknown"}>{measured?flowCount(total):"Unknown"}</strong><span>{measured?`${exact(total)} tokens`:"No measured usage yet"}</span><p>Parent + subagents<br/>Coverage is partial</p></article>
        {positions.map(({group,y,height})=><article key={group.id} data-task-id={group.taskId??undefined} className="tf-topology-group" data-related={related(group.id)} style={{left:348,top:y,height}}>
          <button className="tf-topology-group-title" aria-expanded={expanded.has(group.id)} aria-label={`${expanded.has(group.id)?"Collapse":"Expand"} ${group.name}`} onClick={()=>{setSelected(group.id);setExpanded(old=>{const next=new Set(old);next.has(group.id)?next.delete(group.id):next.add(group.id);return next;});}}>
            <span>{expanded.has(group.id)?"▾":"▸"} {group.name}</span><strong title={group.measured?`${exact(group.total)} recorded tokens`:"Usage unknown"}>{group.measured?flowCount(group.total):"Unknown"}</strong>
            <small>{group.rows.length} agent streams · {group.taskId?"Linked task":group.coverage?"Coverage disclosure":"Explicit chat context"}{group.partial?" · partial":""}</small>
          </button>
          {expanded.has(group.id)&&group.rows.map(row=><button className="tf-topology-measurement" key={row.id} aria-pressed={detail?.id===row.id} onClick={()=>{setDetailId(row.id);setSelected(group.id);}}>
            <span title={title(row)}>{title(row)}</span><b>{row.turns===(row.missing??0)?"Unknown":flowCount(measuredAmount(row))}</b><small>{row.head??"Retained agents"} · {row.turns} {row.messages===row.turns?"messages":"measurements"}{row.partial?" · partial":""}</small>
          </button>)}
        </article>)}
        {agents.map((agent,i)=>{const members=rows.filter(r=>agentKey(r)===agent),sum=members.reduce((n,r)=>n+measuredAmount(r),0),known=members.some(r=>r.turns>(r.missing??0));return <button key={agent} className="tf-topology-activity" data-related={!selected||selected===agent||groups.find(g=>g.id===selected)?.rows.some(r=>agentKey(r)===agent)} aria-pressed={selected===agent} style={{left:738,top:54+i*126}} onClick={()=>setSelected(selected===agent?null:agent)}><span>{agentLabel(agent)}</span><strong title={known?`${exact(sum)} tokens`:"Usage unknown"}>{known?flowCount(sum):"Unknown"}</strong><small>{known?`${exact(sum)} recorded tokens`:"Missing usage evidence"}</small></button>;})}
      </div>
    </div>
    {detail&&<aside ref={evidence} className="tf-topology-detail" aria-label="Measurement evidence"><button aria-label="Close measurement evidence" onClick={()=>setDetailId(null)}>×</button><h3>{title(detail)}</h3><p>{detail.taskId?`Task: ${tasks.find(t=>t.id===detail.taskId)?.name??detail.taskId}`:detail.attribution==="chat"?"Chat / no task":detail.attribution==="unresolved"?"Missing dispatch context":detail.attribution==="aggregated"?"Other recorded groups":"Earlier / retained attribution"} · {detail.head} · {detail.messages===detail.turns?"Provider messages":"Provider turns"}</p>
      <dl>{([['input','Uncached input'],['cacheRead','Cache read'],['cacheWrite','Cache write'],['output','Output (includes reasoning)']] as const).map(([key,label])=><div key={key}><dt>{label}</dt><dd>{detail.turns===(detail.missing??0)?"Unknown":exact(detail.tokens[key])}</dd></div>)}</dl>
      <p>{detail.partial?"Partial observations; additional usage may be missing.":"Observed usage for these measurements; provider and history coverage remains partial."}</p><p className="tf-evidence-id">{detail.workerId?`Worker: ${detail.workerId} · `:"Coordinator · "}Thread: {detail.threadId??"Grouped"}{detail.parentThreadId?` · Parent thread: ${detail.parentThreadId}`:""}</p>
    </aside>}
  </div>;
}
