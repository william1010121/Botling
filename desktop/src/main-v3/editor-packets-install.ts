// Wires the steady chat packets (editor-packets.ts) into the 2.x main without changing it. Imported by
// src/main-v3/main.ts before the 2.x main module, so its editor relay registers on the wrapped `ipcMain.on`.
import { ipcMain } from "electron";
import { installEditorPacketFilter, type IpcMainLike } from "./editor-packets";

installEditorPacketFilter(ipcMain as unknown as IpcMainLike);
