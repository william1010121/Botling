import { useEffect, useRef, useState } from "react";
import { RightPanel, RightToggle, type RightPanelProps } from "./RightPanel";
import { ShellOverlay } from "./ShellOverlay";

const narrowQuery = "(max-width: 860px)";

/** A local drawer at narrow widths; the desktop's saved panel preference is never changed. */
export function TaskDetails(props: RightPanelProps & { onDrawerSettings: () => void }) {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(narrowQuery).matches ?? false);
  const [open, setOpen] = useState(false);
  const drawer = useRef<HTMLDivElement>(null);
  const entry = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  useEffect(() => {
    const query = window.matchMedia?.(narrowQuery);
    if (!query) return;
    const change = () => { setNarrow(query.matches); setOpen(false); };
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => { setOpen(false); }, [props.bot.id, props.watching]);
  useEffect(() => {
    const panel = drawer.current;
    if (!narrow || !open || !panel) return;
    const trigger = entry.current;
    const siblings = [...panel.parentElement!.children].filter((node): node is HTMLElement =>
      node instanceof HTMLElement && node !== panel && node !== trigger);
    const inert = siblings.map(node => node.hasAttribute("inert"));
    siblings.forEach(node => node.setAttribute("inert", ""));
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () => [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')]
      .filter(node => !node.closest('[hidden]') && getComputedStyle(node).display !== "none" && getComputedStyle(node).visibility !== "hidden");
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); }
      if (event.key === "Tab") {
        const controls = focusable(), first = controls[0], last = controls.at(-1);
        if (!first) { event.preventDefault(); panel.focus(); }
        else if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    };
    const focusin = (event: FocusEvent) => { if (!panel.contains(event.target as Node)) (focusable()[0] ?? panel).focus(); };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", focusin);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", focusin);
      siblings.forEach((node, i) => { if (!inert[i]) node.removeAttribute("inert"); });
      document.body.style.overflow = overflow;
      if (trigger?.isConnected) trigger.focus();
    };
  }, [narrow, open]);

  if (!narrow) return <><RightPanel {...props} /><RightToggle collapsed={props.collapsed} onToggle={props.onExpand} /></>;
  return <>
    <button ref={entry} type="button" className="task-details-entry" aria-label="Details" aria-expanded={open}
      aria-controls="task-details-drawer" onClick={() => setOpen(true)}>Details</button>
    <ShellOverlay active={open}>
      <div ref={drawer} id="task-details-drawer" className="task-details-drawer" hidden={!open} role="dialog" aria-modal="true" aria-label="Details" tabIndex={-1}>
        <div className="task-details-backdrop" aria-hidden="true" onClick={close} />
        <div className="task-details-sheet">
          <header className="task-details-header"><span>Details</span><button type="button" onClick={close} aria-label="Close Details">Close</button></header>
          <RightPanel {...props} collapsed={false} onSettings={props.onDrawerSettings}
            onSelect={id => { close(); props.onSelect(id); }}
            onOpenSubagent={row => { close(); props.onOpenSubagent(row); }}
            onOpenResult={result => { close(); props.onOpenResult(result); }}
            onJumpToTask={(messageId, taskId) => { close(); props.onJumpToTask(messageId, taskId); }} />
        </div>
      </div>
    </ShellOverlay>
  </>;
}
