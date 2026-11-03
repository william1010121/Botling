// Plugin views in the chat header (`chatHeader` views; the Routines panel is one): a button with the view's title that opens a
// popover under it holding the plugin's frame for the bot on screen. The frame is made when the popover opens and ends when it
// closes, and a popover closes when another bot is shown.
import { useEffect, useState } from "react";
import type { PluginsView } from "../contract";
import type { Client } from "./client";
import { SlotFrame, type BuiltinRunner, type FrameServices } from "./Plugins";
import { ShellOverlay } from "./ShellOverlay";

export type ChatHeaderView = NonNullable<PluginsView["chatHeaderViews"]>[number];

export function ChatHeaderViews({ client, views, botId, onBuiltin, ...services }: { client: Client; views: ChatHeaderView[]; botId: string; onBuiltin?: BuiltinRunner } & FrameServices) {
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { setOpen(null); }, [botId]);
  return <>
    {views.map((view) => {
      const key = `${view.plugin}/${view.id}`;
      return (
        <span key={key} className="header-view">
          <button type="button" className={`header-button${open === key ? " on" : ""}`} aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)}>{view.title}</button>
          {open === key && (
            <ShellOverlay><div className="header-view-panel" role="dialog" aria-label={view.title}>
              <SlotFrame key={botId} client={client} plugin={view.plugin} view={view.id} title={view.title} fontSize={12.5} botId={botId} onBuiltin={onBuiltin} {...services} />
            </div></ShellOverlay>
          )}
        </span>
      );
    })}
  </>;
}
