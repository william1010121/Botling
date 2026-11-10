// A draggable divider beside a column of the window (column-resize.ts): col-resize cursor and a thin blue line on
// hover, live resize while dragging, the width remembered on this device, a double click back to the default, and
// arrow keys while focused. It owns its column's CSS variable on `.shell` from the moment it mounts.
import { useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { applyWidth, clampWidth, COLUMNS, KEY_STEP, loadWidth, measure, saveWidth, startColumnDrag, type ColumnId } from "./column-resize";

export function ColumnDivider({ column, className }: { column: ColumnId; className?: string }) {
  const spec = COLUMNS[column];
  const handle = useRef<HTMLDivElement>(null);
  const shell = () => handle.current?.closest<HTMLElement>(".shell") ?? null;

  // Before the first paint: the saved width, or the stylesheet's default.
  useLayoutEffect(() => { applyWidth(shell(), spec, loadWidth(spec)); }, [spec]);

  const down = (event: PointerEvent<HTMLDivElement>) => {
    const root = shell();
    if (event.button !== 0 || !root || !handle.current) return;
    event.preventDefault();
    startColumnDrag(handle.current, event.nativeEvent, { spec, shell: root, onEnd: (width) => { if (width !== null) saveWidth(spec, width); } });
  };
  const reset = () => { saveWidth(spec, null); applyWidth(shell(), spec, null); };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowLeft" ? -KEY_STEP : event.key === "ArrowRight" ? KEY_STEP : 0;
    if (!step) return;
    const root = shell(), now = measure(root, spec);
    if (!now) return;
    event.preventDefault();
    const width = clampWidth(spec, now.width + (spec.side === "left" ? step : -step), now.room);
    applyWidth(root, spec, width);
    saveWidth(spec, width);
  };

  return (
    <div ref={handle} className={`col-handle${className ? ` ${className}` : ""}`} data-column={column} data-side={spec.side}
      role="separator" aria-orientation="vertical" aria-label={spec.label} title={`${spec.label} (double-click to reset)`} tabIndex={-1}
      onPointerDown={down} onDoubleClick={reset} onKeyDown={key} />
  );
}
