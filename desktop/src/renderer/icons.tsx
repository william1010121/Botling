// Small line icons standing in for the SF Symbols 1.x draws (sidebar.right, sparkles, plus,
// arrow.turn.down.right, clock.badge.checkmark, arrow.uturn.backward, exclamationmark.bubble,
// arrow.up.right, safari, checkmark.circle, slider.horizontal.3). Drawn in the current colour.
const paths: Record<string, string> = {
  bubble: "M3 3h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2v-2H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z",
  grid: "M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM9.5 9.5h4v4h-4z",
  sidebarRight: "M2.5 3.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1zM10 3.5v9M11.6 6h1.4M11.6 8h1.4",
  sparkles: "M8 2.2l1.2 3.3 3.3 1.2-3.3 1.2L8 11.2 6.8 7.9 3.5 6.7l3.3-1.2zM12.6 10.4l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z",
  plus: "M8 3v10M3 8h10",
  turnDownRight: "M4 3v5.5a1.5 1.5 0 0 0 1.5 1.5H12M9.5 7.5L12 10l-2.5 2.5",
  clock: "M7 13.2A5.2 5.2 0 1 1 12.2 8M7 5v3l2 1.2",
  uturn: "M6 4L3 7l3 3M3 7h6.5a3.5 3.5 0 0 1 0 7H8",
  bubbleAlert: "M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5V11.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1zM8 5.5v2.7M8 9.8v.2",
  arrowUpRight: "M5 11l6-6M6 5h5v5",
  safari: "M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM10.4 5.6L9 9 5.6 10.4 7 7z",
  checkCircle: "M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM5.6 8.1l1.6 1.6 3.2-3.4",
  sliders: "M3 5h4M10 5h3M3 11h2M8 11h5M7 3.5v3M5 9.5v3",
  check: "M4 8.4l2.6 2.6L12 5.4",
  xmark: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  sidebarLeft: "M2.5 3.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1zM6 3.5v9M3 6h1.4M3 8h1.4",
  pin: "M6 2.5h4l-.6 4 2.1 2.2H4.5l2.1-2.2zM8 8.7v4.8",
  pinSlash: "M6 2.5h4l-.6 4 2.1 2.2H4.5l2.1-2.2zM8 8.7v4.8M3 3l10 10",
  search: "M7 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM10 10l3 3",
  people: "M8 3.2a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM4.2 13c0-2.2 1.7-3.8 3.8-3.8s3.8 1.6 3.8 3.8M3.6 5a1.5 1.5 0 1 1 0 3M1.2 12.2c0-1.6 1-2.7 2.3-2.9M12.4 5a1.5 1.5 0 1 0 0 3M14.8 12.2c0-1.6-1-2.7-2.3-2.9",
  gear: "M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1",
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 14, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

/** A subagent's end mark (`SubagentRows.mark`): nothing while it works, ✓ done, ! failed, ■ stopped. */
export function SubagentMark({ status }: { status: "running" | "completed" | "failed" | "stopped" }) {
  if (status === "running") return null;
  if (status === "completed") return <span className="subagent-mark done" aria-hidden="true"><Icon name="check" size={10} /></span>;
  if (status === "failed") return <span className="subagent-mark failed" aria-hidden="true">!</span>;
  return <span className="subagent-mark stopped" aria-hidden="true">■</span>;
}
