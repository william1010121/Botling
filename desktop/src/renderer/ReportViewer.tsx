import { useEffect, useRef, useState } from "react";
import { shellPortal } from "./ShellOverlay";

export function ReportViewer({ url, onClose }: { url: string; onClose: () => void }) {
  const back = useRef<HTMLButtonElement>(null);
  const [currentUrl, setCurrentUrl] = useState(url);

  const isSlides = currentUrl.includes("-slides.html");
  const toggleUrl = isSlides
    ? currentUrl.replace("-slides.html", ".html")
    : currentUrl.replace(".html", "-slides.html");

  useEffect(() => {
    const previous = document.activeElement;
    back.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  return shellPortal(<section className="report-viewer" role="dialog" aria-modal="true" aria-label="Report preview"
    onKeyDown={event => { if (event.key === "Escape") onClose(); }}>
    <header style={{ justifyContent: "space-between" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <button ref={back} type="button" onClick={onClose}>← Back to conversation</button>
        <span>Report preview</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <button type="button" onClick={() => setCurrentUrl(toggleUrl)}>
          {isSlides ? "📄 Document View" : "📊 16:9 Slides"}
        </button>
      </div>
    </header>
    <iframe src={currentUrl} title="Full page report" sandbox="allow-scripts" />
  </section>);
}
