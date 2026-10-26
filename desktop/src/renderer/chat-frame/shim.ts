// Runs before the Web/src chat page: the page talks to "the app" through WebKit's
// `webkit.messageHandlers.ccb.postMessage` (Web/src/bridge.ts). Here that goes to the app page
// (the React shell) instead, which owns the contract client.
import { toShell } from "./transport";

// Chromium exposes the event currently dispatching this synchronous bridge call. A component's
// postMessage is a MessageEvent in a separate dispatch, so it cannot inherit a prior click.
function userLink(url:unknown):boolean {
 const event=window.event;
 return event instanceof MouseEvent && event.type==='click' && event.isTrusted
   && (event.target as Element|null)?.closest<HTMLElement>('[data-url]')?.dataset.url===url;
}
(window as unknown as { webkit: unknown }).webkit = Object.freeze({
  messageHandlers: Object.freeze({
    ccb: Object.freeze({
      postMessage(action: unknown) {
        const value = action as {type?:unknown;url?:unknown} | null;
        const linkSource = value?.type === "openURL" && userLink(value.url) ? "user" : "component";
        const event=window.event;
        const component=event instanceof MessageEvent?[...document.querySelectorAll<HTMLIFrameElement>('iframe.component-frame')].find(frame=>frame.contentWindow===event.source):null;
        const linkPinId=component?(component as HTMLIFrameElement & {ccbPin?:string}).ccbPin:undefined;
        const linkMessageId=component&&!linkPinId?(component.closest<HTMLElement>('.row[data-id]')?.dataset.id||'unattributed-component'):undefined;
        toShell({ botling: "action", action: action as {type:string;[key:string]:unknown}, linkSource, ...(linkMessageId?{linkMessageId}:{}), ...(linkPinId?{linkPinId}:{}) });
      },
    }),
  }),
});
export {};
