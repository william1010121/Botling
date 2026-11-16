// The Plugins page's Explore and Updates (core: plugin-store.ts): the public catalog's plugins with what each is to this
// Botling, Install / Update (downloaded and checked by the core, then asked on the usual install card in the main bot's
// chat), and how an install went. Drawn with the Plugins list's own parts (.plugin cards, .plugin-buttons); words through
// the app's dictionaries (`say`).
import { useEffect, useState } from "react";
import type { PluginStoreEntryView, PluginStoreView } from "../contract";
import type { Client } from "./client";
import { say } from "./shortcut-labels";
import type { Lang } from "../../../Web/src/i18n";
import type { Key } from "../../../Web/src/locales/en";

/** The catalog's view: asked for once (the cached copy, no network), then kept up to date by the core's `plugins.store` events. */
export function usePluginStore(client: Client, initial: PluginStoreView | null = null): [PluginStoreView | null, (view: PluginStoreView) => void] {
  const [store, setStore] = useState<PluginStoreView | null>(initial);
  useEffect(() => {
    let live = true;
    // (Some shell tests hand the app a client with only `request`.)
    const off = typeof client.onEvent === "function" ? client.onEvent(({ event }) => { if (event.type === "plugins.store" && live) setStore(event.store); }) : () => {};
    const ask = (tries: number) => {
      void Promise.resolve(client.request({ type: "plugins.store" })).then((view) => { if (live && Array.isArray(view?.entries)) setStore((now) => now ?? view); }, () => {
        // Before the core is ready it refuses; ask again shortly (a few times).
        if (live && tries > 0) setTimeout(() => ask(tries - 1), 2_000);
      });
    };
    ask(5);
    return () => { live = false; off(); };
  }, [client]);
  return [store, setStore];
}

const PERMISSION_KEYS: Record<string, Key> = {
  composer: "plugins.perm.composer", messages: "plugins.perm.messages", network: "plugins.perm.network", files: "plugins.perm.files",
  exec: "plugins.perm.exec", bots: "plugins.perm.bots", claude: "plugins.perm.claude",
};

/** What each permission of a plugin means, in the user's words (a permission this Botling does not know stays as it is). */
export function permissionWords(lang: Lang | null, permissions: readonly string[]): string[] {
  return permissions.map((permission) => (Object.hasOwn(PERMISSION_KEYS, permission) ? say(lang, PERMISSION_KEYS[permission]!) : permission));
}

export const sizeLabel = (bytes: number) => (bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1_000))} KB`);
const when = (ms: number) => new Date(ms).toLocaleString();

/** The catalog's state above the list: where it is from and when, offline, a failed fetch, a test catalog. */
function CatalogHead({ store, lang, onRefresh }: { store: PluginStoreView | null; lang: Lang | null; onRefresh: () => void }) {
  const w = (key: Key, values?: Record<string, string | number>) => say(lang, key, values);
  return (
    <div className="plugins-catalog">
      <div className="plugin-row">
        <span className="plugin-meta">{store?.fetchedAt ? w("plugins.catalogFrom", { when: when(store.fetchedAt) }) : w("plugins.catalogNever")}</span>
        <span className="plugin-buttons plugins-catalog-buttons">
          <button type="button" disabled={store?.loading} onClick={onRefresh}>{store?.loading ? w("plugins.checking") : w("plugins.checkAgain")}</button>
        </span>
      </div>
      {store && !store.official && <div className="plugin-meta">{w("plugins.catalogTest", { url: store.url })}</div>}
      {store?.offline && (store.fetchedAt ? <p className="plugins-problem" role="status">{w("plugins.offline", { when: when(store.fetchedAt) })}</p>
        : <p className="plugins-problem" role="status">{w("plugins.offlineEmpty")}</p>)}
      {store?.error && !store.offline && (
        <p className="plugins-problem" role="status">{w("plugins.fetchFailed", { error: store.error })}{store.fetchedAt && store.fromCache ? ` ${w("plugins.cachedFrom", { when: when(store.fetchedAt) })}` : ""}</p>
      )}
      {store?.loading && !store.entries.length && <p className="plugins-empty">{w("plugins.loading")}</p>}
    </div>
  );
}

/** One catalog plugin: what it is and asks for, and what can be done with it here. */
function StoreItem({ entry, lang, onInstall, onShowCard, onDismiss }: { entry: PluginStoreEntryView; lang: Lang | null; onInstall: () => void; onShowCard?: () => void; onDismiss: () => void }) {
  const w = (key: Key, values?: Record<string, string | number>) => say(lang, key, values);
  const status = entry.status;
  const busy = status?.kind === "checking" || status?.kind === "asking";
  const permissions = permissionWords(lang, entry.permissions);
  let action: React.ReactNode;
  if (entry.state === "available" || entry.state === "update") {
    action = <button type="button" className="plugin-store-install" disabled={busy} onClick={onInstall}>
      {status?.kind === "checking" ? w("plugins.checking") : entry.state === "update" ? w("plugins.update", { version: entry.version }) : w("plugins.install")}
    </button>;
  } else {
    const label = entry.state === "installed" ? w("plugins.installed") : entry.state === "builtIn" ? w("plugins.builtIn")
      : entry.state === "devCopy" ? w("plugins.devCopyShort") : entry.state === "unreleased" ? w("plugins.unreleased")
      : entry.minAppVersion ? w("plugins.tooOld", { version: entry.minAppVersion }) : w("plugins.tooOldEngines");
    action = <span className={entry.state === "tooOld" ? "plugins-problem plugin-store-state" : "plugin-meta plugin-store-state"}>{label}</span>;
  }
  return (
    <li className="plugin plugin-store" data-plugin={entry.name} data-state={entry.state}>
      <div className="plugin-row">
        <span className="plugin-tile" aria-hidden="true">{Array.from(entry.title.trim())[0]?.toUpperCase() ?? "?"}</span>
        <div className="plugin-title plugin-store-name">{entry.title} <span className="plugin-version">{entry.installedVersion && entry.state === "update" ? `${entry.installedVersion} → ${entry.version}` : entry.version}</span></div>
        <span className="plugin-buttons plugin-store-action">{action}</span>
      </div>
      {entry.description && <div className="plugin-description">{entry.description}</div>}
      <div className="plugin-meta">
        {[entry.license ? w("plugins.license", { license: entry.license }) : w("plugins.noLicense"), entry.minAppVersion ? w("plugins.minApp", { version: entry.minAppVersion }) : null, entry.size ? sizeLabel(entry.size) : null].filter(Boolean).join(" · ")}
      </div>
      <div className="plugin-meta">{permissions.length ? w("plugins.asksFor", { list: permissions.join(", ") }) : w("plugins.asksNothing")}</div>
      {status?.kind === "asking" && (
        <div className="plugin-row plugin-store-status">
          <span className="plugins-result" role="status">{w("plugins.asking")}</span>
          {onShowCard && <span className="plugin-buttons"><button type="button" onClick={onShowCard}>{w("plugins.showCard")}</button></span>}
        </div>
      )}
      {(status?.kind === "installed" || status?.kind === "declined" || status?.kind === "failed") && (
        <div className="plugin-row plugin-store-status">
          <span className={status.kind === "failed" ? "plugins-problem" : status.kind === "installed" ? "plugins-result" : "plugin-meta"} role="status">
            {status.kind === "failed" ? status.message : status.kind === "installed" ? w("plugins.didInstall") : w("plugins.declined")}
          </span>
          <span className="plugin-buttons"><button type="button" onClick={onDismiss}>{w("plugins.dismiss")}</button></span>
        </div>
      )}
    </li>
  );
}

/** The Store tab: every plugin of the public catalog, two to a row. */
export function StoreList({ client, store, setStore, lang, onShowCard, onProblem }: {
  client: Client; store: PluginStoreView | null; setStore: (view: PluginStoreView) => void; lang: Lang | null;
  onShowCard?: () => void; onProblem: (problem: string | null) => void;
}) {
  const w = (key: Key, values?: Record<string, string | number>) => say(lang, key, values);
  const act = (promise: Promise<PluginStoreView>) => { onProblem(null); void promise.then(setStore, (failure) => onProblem(String((failure as Error)?.message ?? failure))); };
  const refresh = () => act(client.request({ type: "plugins.store", refresh: true }));
  // Opening the Store checks the catalog once (later, "Check again").
  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const entries = store?.entries ?? [];
  return (
    <div className="plugins-store" data-list="all">
      <CatalogHead store={store} lang={lang} onRefresh={refresh} />
      <p className="plugin-meta plugins-store-note">{w("plugins.exploreNote")}</p>
      {store && !store.loading && !entries.length && (store.fetchedAt || !store.error) && <p className="plugins-empty">{w("plugins.exploreEmpty")}</p>}
      <ul>
        {entries.map((entry) => (
          <StoreItem key={entry.name} entry={entry} lang={lang} onShowCard={onShowCard}
            onInstall={() => act(client.request({ type: "plugins.storeInstall", name: entry.name, ...(entry.state === "update" ? { direct: true } : {}) }))}
            onDismiss={() => act(client.request({ type: "plugins.storeDismiss", name: entry.name }))} />
        ))}
      </ul>
    </div>
  );
}
