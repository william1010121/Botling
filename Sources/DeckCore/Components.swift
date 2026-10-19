import Combine
import Foundation

/// A component drawn in a chat message, with the data it was given.
public struct ComponentInstance: Codable, Equatable, Sendable {
    public var name: String
    /// JSON for `window.deck.data`.
    public var data: String

    public init(name: String, data: String) {
        self.name = name
        self.data = data
    }
}

/// The parts of Deck's chat that are HTML templates instead of fixed code: one folder each,
/// holding `template.html` and `about.md` (what data it takes). They live in the `deck-components`
/// plugin (`~/.deck/plugins/deck-components/components/<name>/`); other plugins can bring more.
/// Changes are asked of Deck 維護; Deck notices the file change and redraws without a restart.
/// Earlier versions are in the plugin library's git history.
@MainActor
public final class ComponentLibrary: ObservableObject {
    /// Bumps when a template changes on disk, so views reload it.
    @Published public private(set) var versions: [String: Int] = [:]
    /// Components being changed now, with what was asked.
    @Published public private(set) var working: [String: String] = [:]
    /// Changed since Deck started (shows 「已更新」 beside them).
    @Published public private(set) var updated: Set<String> = []
    @Published public private(set) var names: [String] = []

    /// Where new components are made: the deck-components plugin.
    public let folder: URL
    /// Component folders from other plugins, searched after `folder`.
    var otherFolders: () -> [URL] = { [] }
    /// The plugin library's git, for earlier versions; nil when the library is not a repo.
    var git: PluginLibraryGit?
    /// A component appeared, disappeared, or its about.md changed: bots should get the new usage.
    var onCatalogChanged: (() -> Void)?
    private var modified: [String: Date] = [:]
    private var aboutModified: [String: Date] = [:]
    private var previous: [String: Bool] = [:]
    private var watchTask: Task<Void, Never>?

    public init(folder: URL) {
        self.folder = folder
        seedDefaults()
        rescan()
    }

    // MARK: Reading

    /// The folder holding component `name`: the first that has it, or `folder` for a new one.
    func home(of name: String) -> URL {
        for root in [folder] + otherFolders() where FileManager.default.fileExists(atPath: root.appending(path: "\(name)/template.html").path) {
            return root
        }
        return folder
    }

    public func templateURL(_ name: String) -> URL {
        home(of: name).appending(path: "\(name)/template.html")
    }

    public func template(_ name: String) -> String? {
        try? String(contentsOf: templateURL(name), encoding: .utf8)
    }

    /// There is an earlier version in git to go back to. Asked in the background: false until git
    /// has answered, then the views redraw.
    public func hasPrevious(_ name: String) -> Bool {
        if let known = previous[name] { return known }
        previous[name] = false
        if let git, let path = gitPath(name) {
            Task { [weak self] in
                let answer = await Task.detached { git.hasPrevious(path) }.value
                guard let self, previous[name] != nil else { return }
                if previous[name] != answer {
                    previous[name] = answer
                    objectWillChange.send()
                }
            }
        }
        return false
    }

    /// The component's folder relative to the plugin library, when it is inside it.
    private func gitPath(_ name: String) -> String? {
        guard let git else { return nil }
        let base = git.folder.standardizedFileURL.path + "/"
        let path = home(of: name).appending(path: name).standardizedFileURL.path
        return path.hasPrefix(base) ? String(path.dropFirst(base.count)) : nil
    }

    /// Every component with its whole about.md (what it is, its data, what it answers), so a bot
    /// can use one correctly without opening the folder.
    public func catalog() -> String {
        names.map { name in
            let about = ((try? String(contentsOf: aboutURL(name), encoding: .utf8)) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let lines = about.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            let first = lines.first ?? ""
            let rest = lines.dropFirst().map { "  " + $0 }.joined(separator: "\n")
            return "- \(name)：\(first)" + (rest.isEmpty ? "" : "\n" + rest)
        }.joined(separator: "\n")
    }

    func aboutURL(_ name: String) -> URL {
        home(of: name).appending(path: "\(name)/about.md")
    }

    // MARK: Changing

    /// The library's git became ready (or changed under it): ask it again.
    public func forgetHistory() {
        previous = [:]
        objectWillChange.send()
    }

    /// Deck 維護 was asked to change `name`: show it as being worked on.
    public func markWorking(_ name: String, change: String) {
        working[Self.safeName(name)] = change
    }

    /// Deck 維護 finished its turn.
    public func finishWorking() {
        guard !working.isEmpty else { return }
        rescan()
        working = [:]
    }

    /// Puts back the version from before the last change (git), then redraws.
    @discardableResult
    public func revert(_ name: String) async -> String? {
        guard let git, let path = gitPath(name) else { return "這個組件沒有版本紀錄。" }
        let problem = await Task.detached { git.revert(path, label: "組件 \(name)") }.value
        updated.remove(name)
        previous[name] = nil
        rescan()
        return problem
    }

    // MARK: Watching

    /// Picks up template edits made by Deck 維護 or by hand.
    public func startWatching(every interval: TimeInterval = 1.5) {
        watchTask?.cancel()
        watchTask = Task { [weak self] in
            while !Task.isCancelled {
                self?.rescan()
                try? await Task.sleep(for: .seconds(interval))
            }
        }
    }

    public func rescan() {
        let entries = ([folder] + otherFolders()).flatMap {
            (try? FileManager.default.contentsOfDirectory(at: $0, includingPropertiesForKeys: nil)) ?? []
        }
        let found = Set(entries
            .filter { FileManager.default.fileExists(atPath: $0.appending(path: "template.html").path) }
            .map(\.lastPathComponent))
            .sorted()
        var catalogChanged = false
        if found != names {
            // The first scan only learns what is there.
            catalogChanged = !modified.isEmpty || !names.isEmpty
            names = found
        }
        for name in found {
            let date = (try? FileManager.default.attributesOfItem(atPath: templateURL(name).path)[.modificationDate]) as? Date
            if let date, modified[name] != date {
                if modified[name] != nil {
                    versions[name, default: 0] += 1
                    updated.insert(name)
                }
                modified[name] = date
                previous[name] = nil
            }
            let aboutDate = (try? FileManager.default.attributesOfItem(atPath: aboutURL(name).path)[.modificationDate]) as? Date
            if aboutModified[name] != aboutDate {
                if aboutModified.keys.contains(name) { catalogChanged = true }
                aboutModified[name] = aboutDate
                previous[name] = nil
            }
        }
        if catalogChanged { onCatalogChanged?() }
    }

    // MARK: Setup

    private func seedDefaults() {
        for (name, template, about) in [("choices", ComponentDefaults.choicesTemplate, ComponentDefaults.choicesAbout)] {
            let componentFolder = folder.appending(path: name)
            try? FileManager.default.createDirectory(at: componentFolder, withIntermediateDirectories: true)
            for (file, text, older) in [
                ("template.html", template, ComponentDefaults.olderChoicesTemplates),
                ("about.md", about, ComponentDefaults.olderChoicesAbouts)
            ] {
                let url = componentFolder.appending(path: file)
                let current = try? String(contentsOf: url, encoding: .utf8)
                // Write it when missing, or bring a shipped default nobody edited up to date.
                if current == nil || older.contains(current!) {
                    try? Data(text.utf8).write(to: url)
                }
            }
        }
    }

    static func safeName(_ name: String) -> String {
        String(name.lowercased().map { $0.isLetter || $0.isNumber || $0 == "-" ? $0 : "-" })
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }
}

/// How a component is written; the deck-core:component-editor agent's instructions.
enum ComponentPrompts {
    static let system = """
    你是 Deck 的組件編輯（component-editor）。你負責對話裡的一個組件：它的資料夾裡有 template.html，用法寫在 about.md。
    - template.html 是一段 HTML（可以有 <style> 和 <script>），畫在深色背景 #1B1B1F 上，寬度跟著外框，高度跟著內容。
    - 資料在 window.deck.data。使用者回答一律呼叫 deck.answer(...)：給數字是選第幾個選項（從 0 開始），給文字是使用者自己打的回答（例如「其他」輸入框）。App 兩種都會當成已回答，並把答案轉給問問題的 bot。
    - 選擇題類的資料裡，chosen 是已選的第幾個、answer 是自己打的回答；任一個不是 null 就代表答過了，要顯示答案並停用按鈕。
    - 文字顏色 #EDEDF0、次要文字 #A0A0A8、強調藍 #4C8DFF、建議橘 #F7C27F；字型用 -apple-system, "PingFang TC", sans-serif。
    - 不要載入任何外部資源。用真的 <button> 和 <input>，按鈕高度至少 44px，對比要夠。
    - 使用者用中文輸入法打字：按 Enter 送出前一定要檢查 event.isComposing，選字時的 Enter 不能送出。
    - about.md 是給所有 bot 看的使用說明，它們只靠這份檔案學怎麼用你的組件：第一行一句話說這是什麼，接著寫資料格式（附一個範例 JSON）和使用者回答時 bot 會收到什麼。只要格式或回答方式有變，就一定要更新 about.md。
    - 只改那個組件資料夾裡的檔案，不要 commit（交給你的人會檢查和 commit）。改完只回一句話，說你改了什麼。
    """
}

/// The templates Deck ships with; written to `~/.deck/components/` the first time.
enum ComponentDefaults {
    /// Earlier shipped versions, replaced on launch only if still unedited.
    static let olderChoicesAbouts = ["""
    選擇題：一排按鈕讓使用者選一個，建議的那個會標出來。
    資料：{"options":[{"label":"用預設圖補上","detail":"今天做完","recommended":true},{"label":"先留白","detail":null,"recommended":false}],"chosen":null}
    chosen 是已選的第幾個（從 0 開始），還沒選是 null。按下第 i 個時呼叫 deck.choose(i)。
    """]

    static var olderChoicesTemplates: [String] {
        [choicesTemplate
            .replacingOccurrences(of: "button.addEventListener('click', () => deck.answer(index));", with: "button.addEventListener('click', () => deck.choose(index));")
            .replacingOccurrences(of: "button.disabled = data.chosen != null || data.answer != null;", with: "button.disabled = data.chosen != null;")
            .replacingOccurrences(of: "+ ((data.chosen != null || data.answer != null) && !picked ? ' faded' : '');", with: "+ (data.chosen != null && !picked ? ' faded' : '');")]
    }

    static let choicesAbout = """
    選擇題：一排按鈕讓使用者選一個，建議的那個會標出來。bot 不用直接畫它：在回覆最後寫 <choices> 區塊，App 就會用這個組件。
    資料：{"options":[{"label":"用預設圖補上","detail":"今天做完","recommended":true},{"label":"先留白","detail":null,"recommended":false}],"chosen":null,"answer":null}
    chosen 是已選的第幾個（從 0 開始），answer 是使用者自己打的回答，都還沒有就是 null。
    使用者回答時，bot 會收到他選的那一項文字，或他自己打的字。
    """

    static let choicesTemplate = """
    <style>
      .list { display: flex; flex-direction: column; gap: 8px; }
      .option {
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
        min-height: 48px; padding: 10px 14px; box-sizing: border-box; width: 100%;
        border-radius: 12px; border: 1px solid #303037; background: #232328;
        color: #EDEDF0; font: inherit; font-size: 14px; text-align: left; cursor: pointer;
      }
      .option.recommended { border-color: #6B4A1F; }
      .option.picked { border-color: #4C8DFF; background: #1E2A44; }
      .option.faded { opacity: 0.4; }
      .option:disabled { cursor: default; }
      .detail { font-size: 12px; color: #A0A0A8; white-space: nowrap; }
      .recommended .detail { color: #F7C27F; }
      .check { color: #4C8DFF; font-weight: 600; }
    </style>
    <div class="list" id="list"></div>
    <script>
      const data = window.deck.data;
      const list = document.getElementById('list');
      data.options.forEach((option, index) => {
        const picked = data.chosen === index;
        const button = document.createElement('button');
        button.className = 'option'
          + (option.recommended && data.chosen == null ? ' recommended' : '')
          + (picked ? ' picked' : '')
          + ((data.chosen != null || data.answer != null) && !picked ? ' faded' : '');
        button.disabled = data.chosen != null || data.answer != null;
        const label = document.createElement('span');
        label.textContent = option.label;
        const side = document.createElement('span');
        if (picked) {
          side.className = 'check';
          side.textContent = '✓';
        } else {
          side.className = 'detail';
          side.textContent = option.recommended
            ? (option.detail ? '建議 · ' + option.detail : '建議')
            : (option.detail || '');
        }
        button.append(label, side);
        button.addEventListener('click', () => deck.answer(index));
        list.append(button);
      });
    </script>
    """
}
