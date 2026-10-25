import {contextBridge,ipcRenderer} from 'electron';
import {editorPreloadAllowed} from '../editor-host-wire';
import {editorBridge} from './editor-bridge';
// Distinct preload only for the unprivileged root editor. Never window.botling, core or trace IPC.
if(editorPreloadAllowed(process.isMainFrame,globalThis.location?.href??'',process.argv))contextBridge.exposeInMainWorld('botlingEditor',editorBridge(ipcRenderer,'editor'));
