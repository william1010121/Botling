// A QR code as one SVG path (mobile-bridge/qr.ts encodes it here, offline; the link never leaves this window).
import { useMemo } from "react";
import { qrEncode, qrPath } from "../mobile-bridge/qr";

export function QrCode({ text, label }: { text: string; label: string }) {
  const shape = useMemo(() => { try { return qrPath(qrEncode(text)); } catch { return null; } }, [text]);
  if (!shape) return null;
  return (
    <svg className="qr-code" role="img" aria-label={label} viewBox={`0 0 ${shape.size} ${shape.size}`} width={224} height={224} shapeRendering="crispEdges">
      <rect width={shape.size} height={shape.size} fill="#fff" />
      <path d={shape.d} fill="#000" />
    </svg>
  );
}
