// What the chat frame and the page's shell say to each other about attachments (M2 step 12). The frame (sandboxed,
// opaque origin) cannot reach the server: the composer's `+` button opens a file input there, and a pasted or dropped
// file is caught there too; the frame hands each `File` to the shell (structured clone, no copy of the bytes into a
// string), and the shell uploads it over the session (src/fe-link/uploader.ts). The shell tells the frame each upload's
// progress for the line under the composer; the chips in the input box come from the snapshot (bridge-v3.ts).

export type FrameUploadMessage = { botling3: "upload.add"; botId: string; files: File[] };

export interface UploadRow {
  key: string;
  botId: string;
  name: string;
  /** "hashing", "waiting", "uploading", "done", "failed". */
  state: string;
  sent: number;
  size: number;
  error?: string;
}

export type ShellUploadMessage = { botling3: "uploads"; items: UploadRow[] };

/** The words under the composer for one upload. */
export function uploadRowText(row: UploadRow): string {
  const pct = row.size ? Math.floor((row.sent / row.size) * 100) : 0;
  switch (row.state) {
    case "hashing": return `${row.name}: reading…`;
    case "waiting": return `${row.name}: waiting for the connection · ${pct}%`;
    case "uploading": return `${row.name}: sending · ${pct}%`;
    case "done": return `${row.name}: on the server`;
    case "failed": return `${row.name}: ${row.error ?? "could not be sent"}`;
    default: return row.name;
  }
}
