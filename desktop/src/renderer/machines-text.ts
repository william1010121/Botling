// Settings › Machines' words, English and Traditional Chinese (the app's two UI languages).
type Words = {
  title: string; note: string; off: string; unavailable: string;
  list: string; none: string; viaSsh: (host: string) => string; viaRelay: string;
  trust: { asked: string; trusted: string; revoked: string }; online: string; offline: string; workers: (n: number) => string;
  checked: (what: string) => string; checkFailed: (error: string) => string; noClaude: string;
  fingerprint: string; knownKey: string; newKey: string; approveKey: string; codeLabel: string; codeHint: string; approve: string; decline: string;
  pairingEnded: string; check: string; checking: string; revoke: string; revokeAsk: (name: string) => string; revokeYes: string; remove: string; cancel: string;
  sshTitle: string; sshNote: string; host: string; noHosts: string; name: string; namePlaceholder: string; add: string; adding: string;
  relayTitle: string; relayNote: string; relayOff: string; relayState: { off: string; connecting: string; online: string; offline: string };
  create: string; creating: string; commandLabel: string; copy: string; copied: string; expires: (minutes: number) => string; hide: string;
};
const en: Words = {
  title: "Machines",
  note: "Run Claude workers on another computer. Its project goes there as the current commit, the worker works on a branch there, and the branch comes back here. A bot uses a machine when it hands a worker to it, or for all its workers when its settings name one.",
  off: "Workers on other machines are not available in this copy of Botling.",
  unavailable: "Machines are not available here.",
  list: "Machines", none: "No machines yet. Add one below.", viaSsh: (host) => `SSH · ${host}`, viaRelay: "Relay",
  trust: { asked: "Waiting for approval", trusted: "Approved", revoked: "Revoked" }, online: "connected", offline: "not connected", workers: (n) => `${n} worker${n === 1 ? "" : "s"} on it`,
  checked: (what) => `Checked: ${what}`, checkFailed: (error) => `Check failed: ${error}`, noClaude: "Claude not found",
  fingerprint: "Fingerprint", knownKey: "This key is already in your ~/.ssh/known_hosts.", newKey: "Compare it with the machine's key before approving.",
  approveKey: "Approve key", codeLabel: "Code shown on the machine", codeHint: "Type the code the install line printed there (XXXX-XXXX).", approve: "Approve", decline: "Decline",
  pairingEnded: "Its pairing ended before it was approved. Run a new install line on it.",
  check: "Check", checking: "Checking…", revoke: "Revoke", revokeAsk: (name) => `Revoke ${name}? Its workers stop, and it must be added again to be used.`, revokeYes: "Revoke", remove: "Remove", cancel: "Cancel",
  sshTitle: "Add a machine over SSH", sshNote: "A host from your ~/.ssh/config that you can log in to with a key. Botling reads its host key; you approve the fingerprint, then Botling installs its agent there under ~/.botling-agent.",
  host: "Host", noHosts: "No hosts in ~/.ssh/config", name: "Name", namePlaceholder: "Same as the host", add: "Add", adding: "Reading its key…",
  relayTitle: "Add a machine over the relay", relayNote: "For a machine with no public address or VPN. Run the line on it: it downloads Botling's agent, checks it is the very file this Botling ships, installs it under ~/.botling-agent, and shows the machine's name, fingerprint and a code. Then approve it above with that code.",
  relayOff: "The relay is off. Turn it on in Settings › Phone (the same relay serves machines).",
  relayState: { off: "Relay idle", connecting: "Connecting to the relay…", online: "Connected to the relay", offline: "Relay not connected — retrying" },
  create: "Create install line", creating: "Creating…", commandLabel: "Run this on the machine", copy: "Copy", copied: "Copied", expires: (m) => `Works once, expires in ${m} min`, hide: "Hide",
};
const zh: Words = {
  title: "機器",
  note: "在另一台電腦上執行 Claude worker。專案以目前的 commit 送過去，worker 在那邊的分支上工作，結束後分支會帶回這裡。機器人把 worker 交給某台機器時會用它；也可以在機器人設定中指定，讓它所有的 worker 都在那台機器上執行。",
  off: "這個 Botling 無法使用其他機器上的 worker。",
  unavailable: "這裡無法使用機器。",
  list: "機器", none: "尚未加入機器。請在下方加入。", viaSsh: (host) => `SSH · ${host}`, viaRelay: "中繼站",
  trust: { asked: "等待核准", trusted: "已核准", revoked: "已撤銷" }, online: "已連線", offline: "未連線", workers: (n) => `${n} 個 worker 在上面`,
  checked: (what) => `檢查結果：${what}`, checkFailed: (error) => `檢查失敗：${error}`, noClaude: "找不到 Claude",
  fingerprint: "指紋", knownKey: "這把金鑰已在你的 ~/.ssh/known_hosts 中。", newKey: "核准前請和該機器的金鑰比對。",
  approveKey: "核准金鑰", codeLabel: "機器上顯示的代碼", codeHint: "輸入安裝指令在那台機器上印出的代碼（XXXX-XXXX）。", approve: "核准", decline: "拒絕",
  pairingEnded: "它的配對在核准前就結束了。請在那台機器上執行新的安裝指令。",
  check: "檢查", checking: "檢查中…", revoke: "撤銷", revokeAsk: (name) => `要撤銷 ${name} 嗎？它上面的 worker 會停止，之後要再加入才能使用。`, revokeYes: "撤銷", remove: "移除", cancel: "取消",
  sshTitle: "透過 SSH 加入機器", sshNote: "從 ~/.ssh/config 中選一台你能用金鑰登入的主機。Botling 會讀取它的主機金鑰；你核准指紋後，Botling 會把它的 agent 安裝在那邊的 ~/.botling-agent。",
  host: "主機", noHosts: "~/.ssh/config 中沒有主機", name: "名稱", namePlaceholder: "與主機相同", add: "加入", adding: "讀取金鑰中…",
  relayTitle: "透過中繼站加入機器", relayNote: "適用於沒有公網位址也沒有 VPN 的機器。在那台機器上執行這行指令：它會下載 Botling 的 agent、確認與這個 Botling 附帶的檔案完全相同、安裝到 ~/.botling-agent，並顯示機器名稱、指紋與一組代碼。然後在上方用那組代碼核准它。",
  relayOff: "中繼站已關閉。請在「設定 › 手機」開啟（機器也使用同一個中繼站）。",
  relayState: { off: "中繼站閒置", connecting: "正在連到中繼站…", online: "已連到中繼站", offline: "未連到中繼站，重試中" },
  create: "產生安裝指令", creating: "產生中…", commandLabel: "在那台機器上執行", copy: "複製", copied: "已複製", expires: (m) => `只能用一次，${m} 分鐘後失效`, hide: "隱藏",
};
export const machinesWords = (lang: string | null): Words => (lang === "zh-Hant" ? zh : en);
