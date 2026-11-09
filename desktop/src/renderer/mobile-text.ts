// The Phone settings' words, English and Traditional Chinese (the app's two UI languages).
type Words = {
  title: string; note: string; off: string; unavailable: string;
  routes: string; routesNote: string; routeKind: { lan: string; tailscale: string; tunnel: string; relay: string }; first: string;
  relayTitle: string; relayNote: string; relayAddress: string; relayOn: string; relayOff: string; relaySaving: string;
  relayState: { off: string; connecting: string; online: string; offline: string }; viaRelay: string;
  pairTitle: string; pairNote: string; allBots: string; route: string; create: string; creating: string; scan: string; expires: (minutes: number) => string; hide: string;
  devices: string; none: string; paired: (when: string) => string; until: (when: string) => string; revoke: string; revokeAsk: (name: string) => string; revokeYes: string; cancel: string; unnamed: string;
};
const en: Words = {
  title: "Phone", note: "Pair a phone or browser with a one-time QR code. A paired phone can chat with all your bots (bots you add later too), and nothing more: no settings, files or plugins.",
  off: "The direct phone connection is not set up on this computer (see desktop/src/mobile-bridge/README.md). You can use the relay below instead.",
  unavailable: "The phone connection is not available here.",
  routes: "Routes", routesNote: "The order a phone tries them. Only addresses from your mobile config are listed.",
  routeKind: { lan: "Local network", tailscale: "Tailscale", tunnel: "Tunnel", relay: "Relay" }, first: "tried first",
  relayTitle: "Relay", relayNote: "Reach Botling from anywhere through a relay server. Botling connects out to it; the phone and Botling encrypt everything end to end, so the relay only passes along data it cannot read.",
  relayAddress: "Relay address", relayOn: "Turn on", relayOff: "Turn off", relaySaving: "Saving…",
  relayState: { off: "Off", connecting: "Connecting…", online: "Connected", offline: "Not connected — retrying" }, viaRelay: "via relay",
  pairTitle: "Pair a phone", pairNote: "Scan the code with the phone's camera. The phone gets all your bots. The code works once and expires in 5 minutes.",
  allBots: "All bots", route: "Address in the code", create: "Create pairing code", creating: "Creating…", scan: "Scan with the phone's camera", expires: (m) => `Expires in ${m} min`, hide: "Hide code",
  devices: "Paired phones", none: "No phones are paired.", paired: (when) => `Paired ${when}`, until: (when) => `until ${when}`, revoke: "Revoke", revokeAsk: (name) => `Sign out ${name}? It will need a new code to connect again.`, revokeYes: "Revoke", cancel: "Cancel", unnamed: "Phone",
};
const zh: Words = {
  title: "手機", note: "用一次性 QR code 配對手機或瀏覽器。配對後的手機可以與你所有的機器人對話（包括之後新增的），但不能做更多：沒有設定、檔案或外掛。",
  off: "這台電腦尚未設定直接手機連線（見 desktop/src/mobile-bridge/README.md）。你可以改用下方的中繼站。",
  unavailable: "這裡無法使用手機連線。",
  routes: "連線路徑", routesNote: "手機嘗試的順序。只列出你在手機設定中指定的位址。",
  routeKind: { lan: "區域網路", tailscale: "Tailscale", tunnel: "通道", relay: "中繼站" }, first: "最先嘗試",
  relayTitle: "中繼站", relayNote: "透過中繼伺服器從任何地方連到 Botling。Botling 主動連出到中繼站；手機與 Botling 之間全程端到端加密，中繼站只轉送它讀不懂的資料。",
  relayAddress: "中繼站位址", relayOn: "開啟", relayOff: "關閉", relaySaving: "儲存中…",
  relayState: { off: "關閉", connecting: "連線中…", online: "已連線", offline: "未連線，重試中" }, viaRelay: "經由中繼站",
  pairTitle: "配對手機", pairNote: "用手機相機掃描代碼，手機就能使用你所有的機器人。代碼只能使用一次，5 分鐘後失效。",
  allBots: "所有機器人", route: "代碼中的位址", create: "建立配對代碼", creating: "建立中…", scan: "用手機相機掃描", expires: (m) => `${m} 分鐘後失效`, hide: "隱藏代碼",
  devices: "已配對的手機", none: "沒有已配對的手機。", paired: (when) => `${when} 配對`, until: (when) => `有效至 ${when}`, revoke: "撤銷", revokeAsk: (name) => `要登出「${name}」嗎？它需要新的代碼才能再次連線。`, revokeYes: "撤銷", cancel: "取消", unnamed: "手機",
};
export const mobileWords = (lang: string | null): Words => (lang === "zh-Hant" ? zh : en);
