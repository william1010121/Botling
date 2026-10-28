import { useEffect, useRef } from "react";
import { shellPortal } from "./ShellOverlay";

export function ReportViewer({ url, onClose }: { url: string; onClose: () => void }) {
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    back.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return shellPortal(<section className="report-viewer" role="dialog" aria-modal="true" aria-label="Report preview"
    onKeyDown={event => { if (event.key === "Escape") onClose(); }}>
    <header><button ref={back} type="button" onClick={onClose}>← Back to conversation</button><span>Report preview</span></header>
    <iframe src={url} title="Full page report" sandbox="allow-scripts" />
  </section>);
}
