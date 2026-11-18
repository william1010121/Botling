// The "More tabs" button at the right end of the header's Chat / tabs switch (dynamic tabs, main-tabs.ts `visibleTabs`): its menu lists every
// plugin tab the bot is offered beyond Note and the Whiteboard, a click opens it (it is then in use, so it shows in the header until the bot leaves it),
// and the pin beside it keeps that tab in this bot's header. The menu is a shell overlay (the chat is a native view laid under it).
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Lang } from "../../../Web/src/i18n";
import { Icon, isIconName } from "./icons";
import { tabKey, type MainTab } from "./main-tabs";
import { ShellOverlay } from "./ShellOverlay";
import { say } from "./shortcut-labels";

export function MoreTabs({ tabs, pinned, botId, lang, onOpen, onPin }: {
  tabs: MainTab[]; pinned: string[]; botId: string; lang: Lang | null | undefined; onOpen: (tab: MainTab) => void; onPin: (tab: MainTab, pinned: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const slot = useRef<HTMLSpanElement>(null);
  // Another bot's header: closed.
  useEffect(() => { setOpen(false); }, [botId]);
  useEffect(() => {
    if (!open) return;
    const away = (event: Event) => { if (!(event.target instanceof Node && slot.current?.contains(event.target))) setOpen(false); };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);
  const keys = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); } };
  const label = say(lang, "tabs.more");
  return (
    <span className="tab-more-slot" ref={slot} onKeyDown={keys}>
      <button type="button" className="main-tab-more" aria-label={label} title={label} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="plus" size={13} /></button>
      {open && (
        <ShellOverlay><div className="tab-more-menu" role="dialog" aria-label={label}>
          {tabs.map((tab) => {
            const key = tabKey(tab);
            const on = pinned.includes(key);
            const pinLabel = say(lang, on ? "tabs.unpin" : "tabs.pin", { name: tab.title });
            return (
              <div key={key} className="tab-more-item">
                <button type="button" className="tab-more-row" data-tab={key} onClick={() => { setOpen(false); onOpen(tab); }}>
                  {tab.icon && isIconName(tab.icon) && <Icon name={tab.icon} size={13} />}{tab.title}
                </button>
                <button type="button" className="tab-more-pin" data-tab={key} aria-pressed={on} aria-label={pinLabel} title={pinLabel} onClick={() => onPin(tab, !on)}><Icon name="pin" size={13} /></button>
              </div>
            );
          })}
          <p className="tab-more-note">{say(lang, "tabs.pinHint")}</p>
        </div></ShellOverlay>
      )}
    </span>
  );
}
