import { pickAttachments } from "./composer-transport";
// Runs before the Web/src chat page: the page talks to "the app" through WebKit's
// `webkit.messageHandlers.ccb.postMessage` (Web/src/bridge.ts). Here that goes to the app page
// (the React shell) instead, which owns the contract client.
import { isReportAction } from "./report-action";
import { nativeChat, toShell } from "./transport";
import { keepDraft, pageDraftStore } from "./draft-keep";
import { clickOpensOutside } from "../../browser-wire";

// Chromium exposes the event currently dispatching this synchronous bridge call. A component's
// postMessage is a MessageEvent in a separate dispatch, so it cannot inherit a prior click.
function userLink(url:unknown):boolean {
 const event=window.event;
 return event instanceof MouseEvent && event.type==='click' && event.isTrusted
   && (event.target as Element|null)?.closest<HTMLElement>('[data-url]')?.dataset.url===url;
}
// A file drag out of the chat (Web/src/lightbox.ts dragFile) comes only from the user's own drag of the link that names it.
function userDrag(url:unknown):boolean {
 const event=window.event;
 return typeof DragEvent!=='undefined' && event instanceof DragEvent && event.type==='dragstart' && event.isTrusted
   && (event.target as Element|null)?.closest<HTMLElement>('[data-url]')?.dataset.url===url;
}
(window as unknown as { webkit: unknown }).webkit = Object.freeze({
  messageHandlers: Object.freeze({
    ccb: Object.freeze({
      postMessage(action: unknown) {
        if ((action as { type?: string })?.type === "pickFiles") { pickAttachments(); return; }
        const value = action as {type?:unknown;url?:unknown} | null;
        if (value?.type === "dragFile" && !userDrag(value.url)) return;
        // Mirrored for Reload Chat Page (draft-keep.ts); the app still receives the action as before.
        if (nativeChat && value?.type === "draft") keepDraft(pageDraftStore(), (value as { botID?: unknown }).botID as string, value as { text?: unknown; cursor?: unknown } as { text: unknown; cursor: unknown });
        const linkSource = value?.type === "openURL" && userLink(value.url) ? "user" : "component";
        const event=window.event;
        // A web link clicked with ⌘ opens in the default browser; a plain click in the app's browser pane.
        const linkExternal = linkSource === "user" && event instanceof MouseEvent && clickOpensOutside(event, /Mac/i.test(navigator.platform) ? "darwin" : "other");
        const component=event instanceof MessageEvent?[...document.querySelectorAll<HTMLIFrameElement>('iframe.component-frame')].find(frame=>frame.contentWindow===event.source):null;
        const linkPinId=component?(component as HTMLIFrameElement & {ccbPin?:string}).ccbPin:undefined;
        const linkMessageId=component&&!linkPinId?(component.closest<HTMLElement>('.row[data-id]')?.dataset.id||'unattributed-component'):undefined;
        toShell({ botling: "action", action: action as {type:string;[key:string]:unknown}, linkSource, reportPreview: isReportAction(component, value), ...(linkExternal ? { linkExternal: true } : {}), ...(linkMessageId?{linkMessageId}:{}), ...(linkPinId?{linkPinId}:{}) });
      },
    }),
  }),
});
export {};
