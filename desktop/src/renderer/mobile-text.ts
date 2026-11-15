// The Phone settings' words, English and Traditional Chinese (the app's two UI languages). `v3`: the Botling 3
// screen (PhoneSettingsV3.tsx: the first pairing's recovery code shown once in a dialog, the 6-digit code check, the relay page).
type V3Words = {
  setup: string; setupNote: string; codeTitle: string; codeNote: string; copyCode: string; copied: string; saved: string;
  pairNote: string; compareTitle: string; compareNote: (device: string) => string; accept: string; reject: string; adding: string; paired: (device: string) => string;
  declined: Record<"code" | "expired" | "cancelled" | "refused", string>;
  relayNote: string; relayFixed: string; added: (when: string) => string;
};
type Words = {
  title: string; note: string; off: string; unavailable: string;
  routes: string; routesNote: string; routeKind: { lan: string; tailscale: string; tunnel: string; relay: string }; first: string;
  relayTitle: string; relayNote: string; relayAddress: string; relayOn: string; relayOff: string; relaySaving: string;
  relayState: { off: string; connecting: string; online: string; offline: string }; viaRelay: string;
  pairTitle: string; pairNote: string; allBots: string; route: string; create: string; creating: string; scan: string; expires: (minutes: number) => string; hide: string; copyLink: string; copied: string; copyNote: string;
  devices: string; none: string; paired: (when: string) => string; until: (when: string) => string; revoke: string; revokeAsk: (name: string) => string; revokeYes: string; cancel: string; unnamed: string;
  v3: V3Words;
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
  allBots: "All bots", route: "Address in the code", create: "Create pairing code", creating: "Creating…", scan: "Scan with the phone's camera", expires: (m) => `Expires in ${m} min`, hide: "Hide code", copyLink: "Copy link", copied: "Copied", copyNote: "Or copy the link and paste it into Botling on the phone (Universal Clipboard, or send it to yourself). It works once, for a few minutes.",
  devices: "Paired phones", none: "No phones are paired.", paired: (when) => `Paired ${when}`, until: (when) => `until ${when}`, revoke: "Revoke", revokeAsk: (name) => `Sign out ${name}? It will need a new code to connect again.`, revokeYes: "Revoke", cancel: "Cancel", unnamed: "Phone",
  v3: {
    setup: "Set up phone pairing",
    setupNote: "Makes a QR code to scan with the phone. The first time, Botling also shows your recovery code once.",
    codeTitle: "Your recovery code", codeNote: "Save this somewhere safe, such as a password manager: it lets you reconnect your devices if this Mac is lost. You won't see it again here.",
    copyCode: "Copy", copied: "Copied", saved: "I've saved it",
    pairNote: "Scan the code with the iPhone's camera and open the link. The phone then shows a 6-digit code: check it against the one shown here. The code works once and expires in 5 minutes.",
    compareTitle: "Check the code", compareNote: (device) => `${device} wants to pair. Does the phone show this code?`,
    accept: "Same code: add the phone", reject: "Different: reject", adding: "Adding the phone…", paired: (device) => `${device} is paired.`,
    declined: {
      code: "Rejected: the codes were different. Make a new pairing code to try again.", expired: "The pairing code expired. Make a new one.",
      cancelled: "The pairing was cancelled.", refused: "The phone was not added. Make a new pairing code to try again.",
    },
    relayNote: "Reach Botling from anywhere through a relay. A phone pairs on the relay's page; the phone and this computer encrypt everything end to end, so the relay only passes along data it cannot read.",
    relayFixed: "BOTLING_SERVER_RELAY_URL sets the relay where Botling runs, so it cannot be changed here.",
    added: (when) => `Paired ${when}`,
  },
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
  allBots: "所有機器人", route: "代碼中的位址", create: "建立配對代碼", creating: "建立中…", scan: "用手機相機掃描", expires: (m) => `${m} 分鐘後失效`, hide: "隱藏代碼", copyLink: "複製連結", copied: "已複製", copyNote: "也可以複製連結，貼到手機上的 Botling（通用剪貼板，或傳給自己）。只能用一次，幾分鐘內有效。",
  devices: "已配對的手機", none: "沒有已配對的手機。", paired: (when) => `${when} 配對`, until: (when) => `有效至 ${when}`, revoke: "撤銷", revokeAsk: (name) => `要登出「${name}」嗎？它需要新的代碼才能再次連線。`, revokeYes: "撤銷", cancel: "取消", unnamed: "手機",
  v3: {
    setup: "設定手機配對",
    setupNote: "產生一個給手機掃描的 QR code。第一次設定時，Botling 也會顯示一次你的復原碼。",
    codeTitle: "你的復原碼", codeNote: "請存到安全的地方（例如密碼管理器）：這台 Mac 遺失時，要靠它重新連回你的裝置。之後這裡不會再顯示。",
    copyCode: "複製", copied: "已複製", saved: "我已存好",
    pairNote: "用 iPhone 相機掃描代碼並開啟連結。手機接著會顯示 6 位數代碼：請與這裡顯示的核對。代碼只能使用一次，5 分鐘後失效。",
    compareTitle: "核對代碼", compareNote: (device) => `「${device}」想要配對。手機上顯示的是這組代碼嗎？`,
    accept: "代碼相同：加入手機", reject: "代碼不同：拒絕", adding: "加入手機中…", paired: (device) => `「${device}」已配對。`,
    declined: {
      code: "已拒絕：兩邊代碼不同。請建立新的配對代碼再試一次。", expired: "配對代碼已過期，請建立新的。",
      cancelled: "配對已取消。", refused: "手機未加入。請建立新的配對代碼再試一次。",
    },
    relayNote: "透過中繼站從任何地方連到 Botling。手機在中繼站的頁面上配對；手機與這台電腦之間全程端到端加密，中繼站只轉送它讀不懂的資料。",
    relayFixed: "執行 Botling 的環境以 BOTLING_SERVER_RELAY_URL 指定了中繼站，因此無法在這裡變更。",
    added: (when) => `${when} 配對`,
  },
};
export const mobileWords = (lang: string | null): Words => (lang === "zh-Hant" ? zh : en);
