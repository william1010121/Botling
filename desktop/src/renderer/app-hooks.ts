import { useCallback, useEffect, useRef, useState } from "react";
import { actionForEvent, commandBindings, commandForEvent } from "../contract/shortcuts";
import type { Client } from "./client";
import type { WorkspaceStore } from "./store";
import { pinnedNumber } from "./app-shared";
import { setShortcutLabels } from "./shortcut-labels";
import { namedBot, mainTabsFor, STORAGE_TAB, type MainTab } from "./main-tabs";
import { openReport } from "./report-opener";
import { postToChat } from "./editor-surface";
import { jumpInPlace } from "./note-dock";
import type { BuiltinRunner } from "./Plugins";

// Hooks cut out of App (M7-S78): each takes what it reads as arguments and returns what App reads. App calls them
// at the places where the code stood, so the order of its hooks does not change.

/** The span in the chat header's right end that a bottom panel's toggle draws into (`BottomPanels`' `toggleHost`). */
export function useBottomControls() {
  return useState<HTMLSpanElement | null>(null);
}

/** What the Note tab's floating chat knows at the moment a plugin frame asks to open a chat at a line (`quoteNow` in App). */
export interface NoteDockNow { botId: string | null; noteKey: string | null; noteOpen: boolean; openNoteChat: (open: boolean) => void }

export interface AppKeysInput {
  shortcutBindings: ReturnType<typeof setShortcutLabels>;
  pluginKeys: ReturnType<typeof commandBindings>;
  openPinned: (n: number) => void;
  openSettings: () => void;
  toggleRight: () => void;
  toggleWorkers: () => void;
  toggleBrowser: () => void;
  toggleRail: () => void;
  startSearch: () => void;
  toggleSubBots: () => void;
  stepRoom: (direction: "back" | "forward") => void;
  runCommand: (id: string, args?: string[], caller?: { from: "frame"; name: string }) => void;
}

/** The app's keys: the callback a panel's frame forwards a key to, and the window's own key and command listeners. */
export function useAppKeys({ openSettings, toggleRight, toggleWorkers, toggleBrowser, toggleRail, startSearch, toggleSubBots, stepRoom, openPinned, shortcutBindings, pluginKeys, runCommand }: AppKeysInput) {
  // A key a panel's frame did not use (a modifier held): runs Botling's shortcuts or that plugin's own bound command (never another plugin's, and never a synthetic window keydown).
  const forwardKey = useCallback((plugin: string, key: { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }) => {
    const action = actionForEvent(key, shortcutBindings);
    const pin = pinnedNumber(action);
    if (pin) { openPinned(pin); return; }
    switch (action) {
      case "settings": openSettings(); break;
      case "toggleRightPanel": toggleRight(); break;
      case "toggleWorkers": toggleWorkers(); break;
      case "toggleBrowser": toggleBrowser(); break;
      case "toggleSidebar": toggleRail(); break;
      case "search": startSearch(); break;
      case "subBots": toggleSubBots(); break;
      case "roomBack": stepRoom("back"); break;
      case "roomForward": stepRoom("forward"); break;
      case null: {
        const command = commandForEvent(key, pluginKeys);
        if (command) runCommand(command, [], { from: "frame", name: plugin });
        break;
      }
    }
  }, [openSettings, toggleRight, toggleWorkers, toggleBrowser, toggleRail, startSearch, toggleSubBots, stepRoom, openPinned, shortcutBindings, pluginKeys, runCommand]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = actionForEvent(event, shortcutBindings);
      const pin = pinnedNumber(action);
      if (pin) { event.preventDefault(); openPinned(pin); return; }
      switch (action) {
        case "settings": event.preventDefault(); openSettings(); break;
        case "toggleRightPanel": event.preventDefault(); toggleRight(); break;
        case "toggleWorkers": event.preventDefault(); toggleWorkers(); break;
        case "toggleBrowser": event.preventDefault(); toggleBrowser(); break;
        case "toggleSidebar": event.preventDefault(); toggleRail(); break;
        case "search": event.preventDefault(); startSearch(); break;
        case "subBots": event.preventDefault(); toggleSubBots(); break;
        case "roomBack": event.preventDefault(); stepRoom("back"); break;
        case "roomForward": event.preventDefault(); stepRoom("forward"); break;
        case null: {
          const command = event.defaultPrevented ? null : commandForEvent(event, pluginKeys);
          if (command) { event.preventDefault(); runCommand(command); }
          break;
        }
      }
    };
    const onCommand = (event: Event) => {
      const pin = pinnedNumber(String((event as CustomEvent).detail));
      if (pin) { openPinned(pin); return; }
      switch ((event as CustomEvent).detail) {
        case "settings": openSettings(); break;
        case "rightPanel": toggleRight(); break;
        case "workers": toggleWorkers(); break;
        case "browser": toggleBrowser(); break;
        case "sidebar": toggleRail(); break;
        case "search": startSearch(); break;
        case "subBots": toggleSubBots(); break;
        case "roomBack": stepRoom("back"); break;
        case "roomForward": stepRoom("forward"); break;
      }
    };
    window.addEventListener("botling:chat-command", onCommand);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("botling:chat-command", onCommand); };
  }, [openSettings, toggleRight, toggleWorkers, toggleBrowser, toggleRail, startSearch, toggleSubBots, stepRoom, openPinned, shortcutBindings, pluginKeys, runCommand]);
  return forwardKey;
}

export interface BuiltinRunnerInput {
  client: Client;
  store: WorkspaceStore;
  fail: (failure: unknown) => void;
  setError: (message: string | null) => void;
  chooseTab: (botId: string, next: MainTab | typeof STORAGE_TAB | null) => void;
  setWhiteboardOn: (on: boolean) => void;
  selectBot: (botId: string) => void;
  /** Read when a chat is opened at a line: App's `quoteNow.current`, which is declared further down than the runner. */
  dockNow: () => NoteDockNow;
}

/** Botling's own commands a plugin frame may run (the runner every plugin frame and the composer bar get). */
export function useBuiltinRunner({ client, store, fail, setError, chooseTab, setWhiteboardOn, selectBot, dockNow: readDock }: BuiltinRunnerInput): BuiltinRunner {
  // The latest reader, so the runner keeps its identity (App's `quoteNow` is a ref declared after this call).
  const dockNow = useRef(readDock);
  dockNow.current = readDock;
  // Botling's own commands a plugin frame may run: a bot's chat (its Chat tab), one of a bot's results.
  const runBuiltin = useCallback<BuiltinRunner>((_plugin, command) => {
    const botId = namedBot(store.getView().bots, command.botId);
    if (!botId) { setError(`No bot "${command.botId.slice(0, 80)}".`); return; }
    if (command.id === "botling.openResult") {
      void client.request({ type: "result.open", botId, url: command.url })
        .then((result) => { if (result.previewURL) openReport(botId, result.previewURL); }).catch(fail);
      return;
    }
    if (command.id === "botling.openLink") {
      // A Markdown file comes back as a report page (main never hands .md to the system's app): shown like the chat's.
      void client.request({ type: "link.open", source: "user", botId, url: command.url })
        .then((result) => { if (result.previewURL) openReport(botId, result.previewURL); }).catch(fail);
      return;
    }
    if (command.id === "botling.openTab") {
      const tab = mainTabsFor(store.getView().plugins, { id: botId, role: store.getView().bots.find((candidate) => candidate.id === botId)?.role ?? "bot", parent: store.getView().bots.find((candidate) => candidate.id === botId)?.parent })
        .find((candidate) => candidate.plugin === command.plugin && candidate.id === command.view);
      if (!tab) { fail(new Error(`No tab "${command.view.slice(0, 80)}".`)); return; }
      selectBot(botId);
      chooseTab(botId, tab);
      return;
    }
    const shown = store.getView().chat?.botId;
    // At one line (botling.openChat(botId, messageId)): from the bot's own tab with the floating chat, that chat opens
    // over the tab; else its Chat shows. The chat page goes to the line once it shows that chat (none such: just the chat).
    const dock = dockNow.current();
    if (jumpInPlace(dock.botId, botId, dock.noteKey, command.messageId)) {
      if (!dock.noteOpen) dock.openNoteChat(true);
    } else {
      if (shown) chooseTab(shown, null);
      chooseTab(botId, null);
      setWhiteboardOn(false);
      selectBot(botId);
    }
    if (command.messageId) postToChat({ botling: "jumpTo", botID: botId, messageID: command.messageId });
  }, [client, store, fail, chooseTab, setWhiteboardOn, selectBot]);
  return runBuiltin;
}
