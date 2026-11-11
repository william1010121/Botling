// The Storage tab (檔案庫, right of Note in the chat header, 2026-11-11): one list per bot of the files it made itself
// (its artifacts folder, listed where they are) and the files the user dragged in (from Finder or the chat, kept as
// references: nothing is copied; a moved or deleted original shows as missing). Search, type chips, sort; double-click,
// Space or Enter previews (a page or Markdown in the app's report preview, anything else with its app). Hold a row and
// drag it onto a web page in the Browser pane: main starts a real OS file drag (storage.drag), so the page's file input
// or drop zone gets the file as an upload. Removing a dragged-in file only forgets it; a bot's own file is not deleted here.
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Lang } from "../../../Web/src/i18n";
import type { Key } from "../../../Web/src/locales/en";
import type { StorageItemView } from "../contract";
import type { Client } from "./client";
import { Icon } from "./icons";
import { openReport } from "./report-opener";
import { say } from "./shortcut-labels";
import { droppedLinks, filterCounts, formatSize, formatWhen, STORAGE_FILTERS, STORAGE_SORTS, totalSize, typeBadge, visibleItems, type StorageFilter, type StorageSort } from "./storage-list";

/** How often the list is read again while it shows (a bot writes reports while you look). */
const REFRESH_MS = 5_000;

const pathForFile = (file: File): string => {
  const bridge = (window as unknown as { botling?: { pathForFile?: (file: File) => string } }).botling;
  try { return bridge?.pathForFile?.(file) ?? ""; } catch { return ""; }
};

export function StorageTab({ client, botId, botName, lang, onError }: {
  client: Client; botId: string; botName: string; lang: Lang | null | undefined; onError: (error: unknown) => void;
}) {
  const w = useCallback((key: Key, values: Record<string, string | number> = {}) => say(lang, key, values), [lang]);
  const [items, setItems] = useState<StorageItemView[] | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<StorageSort>("date");
  const [filter, setFilter] = useState<StorageFilter>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  /** The row being dragged out (its OS drag would otherwise come back as a drop on this list). */
  const draggingOut = useRef<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    void client.request({ type: "storage.list", botId }).then((result) => setItems(result.items), (error) => { setItems((now) => now ?? []); onError(error); });
  }, [client, botId, onError]);
  useEffect(() => {
    setItems(null); setSelected(null); setMenu(null); load();
    const timer = setInterval(() => { if (document.visibilityState === "visible") load(); }, REFRESH_MS);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [load]);

  const shown = useMemo(() => visibleItems(items ?? [], { filter, query, sort }), [items, filter, query, sort]);
  const counts = useMemo(() => filterCounts(items ?? []), [items]);
  const present = useMemo(() => (items ?? []).filter((item) => !item.missing), [items]);

  const preview = useCallback((item: StorageItemView, reveal = false) => {
    setMenu(null);
    if (item.missing && !reveal) return;
    void client.request({ type: "storage.open", botId, id: item.id, ...(reveal ? { reveal } : {}) })
      .then((result) => { if (result.previewURL) openReport(botId, result.previewURL); }, onError);
  }, [client, botId, onError]);
  const remove = useCallback((item: StorageItemView) => {
    setMenu(null);
    if (item.source !== "added") return;
    void client.request({ type: "storage.remove", botId, id: item.id }).then(load, onError);
  }, [client, botId, load, onError]);
  const add = useCallback((paths: string[], urls: string[]) => {
    if (!paths.length && !urls.length) return;
    void client.request({ type: "storage.add", botId, paths: paths.slice(0, 50), urls: urls.slice(0, 50) }).then(load, onError);
  }, [client, botId, load, onError]);
  const pick = useCallback(() => { void client.request({ type: "storage.pick", botId }).then(load, onError); }, [client, botId, load, onError]);

  // A row held and dragged: main takes over with an OS file drag the Browser pane's page (or Finder) can take.
  const dragOut = useCallback((event: DragEvent<HTMLElement>, item: StorageItemView) => {
    event.preventDefault();
    if (item.missing) return;
    draggingOut.current = item.path;
    setTimeout(() => { if (draggingOut.current === item.path) draggingOut.current = null; }, 30_000);
    void client.request({ type: "storage.drag", botId, id: item.id }).catch(onError);
  }, [client, botId, onError]);

  const carriesFiles = (event: DragEvent<HTMLElement>) => [...event.dataTransfer.types].some((type) => type === "Files" || type === "text/uri-list");
  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!dropping) setDropping(true);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    setDropping(false);
    const own = draggingOut.current;
    draggingOut.current = null;
    const paths = [...event.dataTransfer.files].map(pathForFile).filter((path) => path && path !== own);
    const urls = paths.length ? [] : droppedLinks(event.dataTransfer.getData("text/uri-list"));
    add(paths, urls);
  };

  // ↑ ↓ move the selection; Space or Enter previews it.
  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    const at = shown.findIndex((item) => item.id === selected);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = shown[Math.max(0, Math.min(shown.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))];
      if (next) { setSelected(next.id); list.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next.id)}"]`)?.focus(); }
    } else if ((event.key === " " || event.key === "Enter") && at >= 0) {
      event.preventDefault();
      preview(shown[at]!);
    } else if (event.key === "Escape" && menu) {
      setMenu(null);
    }
  };
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => { if (!(event.target as HTMLElement).closest?.(".storage-menu, .storage-more")) setMenu(null); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  const filterLabel = (key: StorageFilter) => key === "bot" ? w("storage.filter.bot", { name: botName }) : w(`storage.filter.${key}` as Key);

  return (
    <div className={`storage-tab${dropping ? " dropping" : ""}`} onDragOver={onDragOver} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false); }} onDrop={onDrop} onKeyDown={onKey}>
      <div className="storage-bar">
        <label className="storage-search">
          <Icon name="search" size={14} />
          <input type="search" value={query} placeholder={w("storage.search")} aria-label={w("storage.search")} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <label className="storage-sort">
          <span>{w("storage.sortLabel")}</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as StorageSort)} aria-label={w("storage.sortLabel")}>
            {STORAGE_SORTS.map((key) => <option key={key} value={key}>{w(`storage.sort.${key}` as Key)}</option>)}
          </select>
        </label>
        <button type="button" className="storage-button" onClick={pick}><Icon name="plus" size={13} />{w("storage.add")}</button>
      </div>
      <div className="storage-chips" role="group" aria-label={w("storage.tab")}>
        {STORAGE_FILTERS.map((key) => (
          <button key={key} type="button" className="storage-chip" aria-pressed={filter === key} onClick={() => setFilter(key)}>
            {filterLabel(key)}<span className="storage-count">{counts[key]}</span>
          </button>
        ))}
      </div>
      <div className="storage-list" ref={list} role="listbox" aria-label={w("storage.tab")}>
        {items !== null && items.length > 0 && (
          <div className="storage-row storage-head" aria-hidden="true">
            <span />
            <span>{w("storage.col.name")}</span>
            <span>{w("storage.col.source")}</span>
            <span className="storage-num">{w("storage.col.size")}</span>
            <span className="storage-num">{w("storage.col.date")}</span>
            <span />
          </div>
        )}
        {items !== null && items.length === 0 && <p className="storage-empty">{w("storage.empty", { name: botName })}</p>}
        {items !== null && items.length > 0 && shown.length === 0 && <p className="storage-empty">{w("storage.noMatch")}</p>}
        {shown.map((item) => (
          <div key={item.id} data-id={item.id} role="option" tabIndex={0} aria-selected={selected === item.id}
            className={`storage-row${selected === item.id ? " selected" : ""}${item.missing ? " missing" : ""}`}
            draggable={!item.missing} onDragStart={(event) => dragOut(event, item)}
            onClick={() => setSelected(item.id)} onDoubleClick={() => preview(item)} onFocus={() => setSelected(item.id)}
            title={item.missing ? `${item.path} — ${w("storage.missing")}` : `${item.path}\n${w("storage.dragHint")}`}>
            <span className={`storage-thumb kind-${item.kind}`}>{typeBadge(item)}</span>
            <span className="storage-name">
              <span className="storage-file">{item.name}</span>
              {item.folder && <span className="storage-folder">{item.folder}/</span>}
            </span>
            <span className="storage-source">{item.source === "bot" ? botName : w("storage.fromYou")}</span>
            <span className="storage-num">{formatSize(item.size)}</span>
            <span className="storage-num">{item.missing ? <span className="storage-missing">{w("storage.missing")}</span> : formatWhen(item.added ?? item.modified ?? 0)}</span>
            <span className="storage-more-slot">
              <button type="button" className="storage-more" aria-label={w("storage.more")} aria-expanded={menu === item.id}
                onClick={(event) => { event.stopPropagation(); setSelected(item.id); setMenu(menu === item.id ? null : item.id); }}>
                <Icon name="more" size={16} />
              </button>
              {menu === item.id && (
                <div className="storage-menu" role="menu">
                  {!item.missing && <button type="button" role="menuitem" onClick={() => preview(item)}>{w("storage.open")}</button>}
                  {!item.missing && <button type="button" role="menuitem" onClick={() => preview(item, true)}>{w("storage.reveal")}</button>}
                  <button type="button" role="menuitem" onClick={() => { setMenu(null); void navigator.clipboard?.writeText(item.path).catch(() => {}); }}>{w("storage.copyPath")}</button>
                  {item.source === "added"
                    ? <button type="button" role="menuitem" className="danger" title={w("storage.removeNote")} onClick={() => remove(item)}>{w("storage.remove")}<small>{w("storage.removeNote")}</small></button>
                    : <p className="storage-menu-note">{w("storage.ownNote", { name: botName })}</p>}
                </div>
              )}
            </span>
          </div>
        ))}
      </div>
      <div className="storage-hint">
        <Icon name="tray" size={14} />
        {w("storage.hint", { n: present.length, size: formatSize(totalSize(present)) })}
      </div>
      {dropping && <div className="storage-drop" aria-hidden="true"><Icon name="plus" size={18} />{w("storage.dropHere")}</div>}
    </div>
  );
}
