// The Phone settings' words, English and Traditional Chinese (the app's two UI languages).
type Words = {
  title: string; note: string; off: string; unavailable: string;
  routes: string; routesNote: string; routeKind: { lan: string; tailscale: string; tunnel: string }; first: string;
  pairTitle: string; pairNote: string; bots: string; route: string; create: string; creating: string; scan: string; expires: (minutes: number) => string; hide: string;
  devices: string; none: string; paired: (when: string) => string; until: (when: string) => string; revoke: string; revokeAsk: (name: string) => string; revokeYes: string; cancel: string; unnamed: string;
};
const en: Words = {
  title: "Phone", note: "Pair a phone or browser with a one-time QR code. A paired phone can do what an access token can: chat with the bots you pick, and nothing more.",
  off: "The phone connection is not set up on this computer. Add a mobile config (see desktop/src/mobile-bridge/README.md), then restart Botling.",
  unavailable: "The phone connection is not available here.",
  routes: "Routes", routesNote: "The order a phone tries them. Only addresses from your mobile config are listed.",
  routeKind: { lan: "Local network", tailscale: "Tailscale", tunnel: "Tunnel" }, first: "tried first",
  pairTitle: "Pair a phone", pairNote: "Choose the bots the phone may use, then scan the code with its camera. The code works once and expires in 5 minutes.",
  bots: "Bots", route: "Address in the code", create: "Create pairing code", creating: "Creating…", scan: "Scan with the phone's camera", expires: (m) => `Expires in ${m} min`, hide: "Hide code",
  devices: "Paired phones", none: "No phones are paired.", paired: (when) => `Paired ${when}`, until: (when) => `until ${when}`, revoke: "Revoke", revokeAsk: (name) => `Sign out ${name}? It will need a new code to connect again.`, revokeYes: "Revoke", cancel: "Cancel", unnamed: "Phone",
};
const zh: Words = {
  title: "手機", note: "用一次性 QR code 配對手機或瀏覽器。配對後的手機只能做存取權杖能做的事：與你選的機器人對話，不會更多。",
  off: "這台電腦尚未設定手機連線。請加入手機設定（見 desktop/src/mobile-bridge/README.md），再重新啟動 Botling。",
  unavailable: "這裡無法使用手機連線。",
  routes: "連線路徑", routesNote: "手機嘗試的順序。只列出你在手機設定中指定的位址。",
  routeKind: { lan: "區域網路", tailscale: "Tailscale", tunnel: "通道" }, first: "最先嘗試",
  pairTitle: "配對手機", pairNote: "選擇手機可使用的機器人，再用手機相機掃描代碼。代碼只能使用一次，5 分鐘後失效。",
  bots: "機器人", route: "代碼中的位址", create: "建立配對代碼", creating: "建立中…", scan: "用手機相機掃描", expires: (m) => `${m} 分鐘後失效`, hide: "隱藏代碼",
  devices: "已配對的手機", none: "沒有已配對的手機。", paired: (when) => `${when} 配對`, until: (when) => `有效至 ${when}`, revoke: "撤銷", revokeAsk: (name) => `要登出「${name}」嗎？它需要新的代碼才能再次連線。`, revokeYes: "撤銷", cancel: "取消", unnamed: "手機",
};
export const mobileWords = (lang: string | null): Words => (lang === "zh-Hant" ? zh : en);
