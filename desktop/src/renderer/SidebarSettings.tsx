// The 1.x sidebar gear's quick controls and shortcuts. Permissions remain the engine's own.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { PluginsView, SettingsView } from "../contract";
import { Client, RequestFailed } from "./client";
import type { SettingsSection } from "./Settings";
import { Icon } from "./icons";
import { QuickSettingsUsage } from "./QuickSettingsUsage";

export function SidebarSettings({ client, settings, plugins, compact = false, settingsOpen, onOpen }: {
  client: Client; settings: SettingsView | null; plugins: PluginsView | null; compact?: boolean;
  settingsOpen: boolean; onOpen: (section?: SettingsSection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => { setShown(settings); }, [settings]);
  useEffect(() => { if (settingsOpen) setOpen(false); }, [settingsOpen]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const button = trigger.current!.getBoundingClientRect();
      const popup = panel.current!.getBoundingClientRect();
      setPosition({
        left: Math.max(12, Math.min(compact ? button.right + 8 : button.left, window.innerWidth - popup.width - 12)),
        top: Math.max(12, Math.min(button.top - popup.height - 8, window.innerHeight - popup.height - 12)),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, compact, problem]);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("input:not(:disabled), button")?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    // Pointer events inside the chat iframe do not bubble to the shell.
    const frameFocus = () => { if (document.activeElement instanceof HTMLIFrameElement) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", frameFocus);
    return () => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("keydown", escape); window.removeEventListener("blur", frameFocus); };
  }, [open]);

  const openSection = (section?: SettingsSection) => { setOpen(false); onOpen(section); };
  const developer = async (value: boolean) => {
    setSaving(true);
    setProblem(null);
    try {
      setShown(await client.request({ type: "settings.set", change: { key: "developerMode", value } }));
    } catch (failure) {
      setProblem(failure instanceof RequestFailed ? failure.error.message : String((failure as Error)?.message ?? failure));
    } finally { setSaving(false); }
  };

  return (
    <div className={`sidebar-settings${compact ? " compact" : ""}`} ref={root}>
      {!compact && <button type="button" className={`rail-button${settingsOpen ? " on" : ""}`} onClick={() => openSection()}>Settings</button>}
      <button ref={trigger} type="button" className={`strip-gear${open ? " on" : ""}`} title="Quick settings: developer mode, plugins, all settings"
        aria-label="Quick settings" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
        <Icon name="gear" size={14} />
      </button>
      {open && <div ref={panel} id={id} className="sidebar-settings-popover" role="dialog" aria-label="Quick settings" style={position}>
        <header><strong>Quick settings</strong><button type="button" aria-label="Close quick settings" onClick={() => { setOpen(false); trigger.current?.focus(); }}>×</button></header>
        <QuickSettingsUsage client={client} />
        <label className="sidebar-settings-switch">
          <span>Develop Botling itself</span>
          <input type="checkbox" role="switch" aria-label="Develop Botling itself" checked={shown?.developerMode ?? false} disabled={!shown || saving}
            onChange={(event) => void developer(event.target.checked)} />
        </label>
        {problem && <p className="settings-problem" role="alert">{problem}</p>}
        <p className="sidebar-settings-note">Auto-approve safe actions follows the current engine's permission rules. Botling 2 has no separate switch.</p>
        <div className="sidebar-settings-links">
          <button type="button" aria-label="Plugins" onClick={() => openSection("plugins")}><span>Plugins</span><span aria-hidden="true">{plugins ? `${plugins.plugins.filter(plugin => plugin.enabled).length} on` : "›"}</span></button>
          <button type="button" onClick={() => openSection("usage")}>Usage by bot<span aria-hidden="true">›</span></button>
          <button type="button" onClick={() => openSection("developer")}>Developer settings…<span aria-hidden="true">›</span></button>
          <button type="button" className="all-settings" onClick={() => openSection()}>All settings…<span aria-hidden="true">⌘ ,</span></button>
        </div>
      </div>}
    </div>
  );
}
