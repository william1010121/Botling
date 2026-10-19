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

/// One request to the component team, kept so you can see what it was asked, what it is doing,
/// and what it said when done.
public struct ComponentJob: Identifiable, Codable, Equatable, Sendable {
    public var id: UUID
    public var name: String
    public var request: String
    public var asker: String
    public var startedAt: Date
    /// What it is doing right now, while working.
    public var activity: String?
    public var summary: String?
    public var finishedAt: Date?
    /// You have opened the component team's page since it finished.
    public var seen: Bool

    public var isWorking: Bool { finishedAt == nil }
}

/// The parts of Deck's chat that are HTML templates instead of fixed code: one folder each in
/// `~/.deck/components/<name>/` holding `template.html` and `about.md` (what data it takes).
/// The component team (Haiku) changes them on request; Deck notices the file change and redraws
/// without a restart. The version before each change is kept as `template.prev.html`.
@MainActor
public final class ComponentLibrary: ObservableObject {
    /// Bumps when a template changes on disk, so views reload it.
    @Published public private(set) var versions: [String: Int] = [:]
    /// Components being changed now, with what was asked.
    @Published public private(set) var working: [String: String] = [:]
    /// Changed since Deck started (shows 「已更新」 beside them).
    @Published public private(set) var updated: Set<String> = []
    @Published public private(set) var names: [String] = []
    /// Every request to the component team, oldest first.
    @Published public private(set) var jobs: [ComponentJob] = []

    public let folder: URL
    private let launcher: AgentLauncher
    /// Tells the main bot's chat when a change lands.
    var onChanged: ((_ name: String, _ summary: String) -> Void)?
    /// A component appeared, disappeared, or its about.md changed: bots should get the new usage.
    var onCatalogChanged: (() -> Void)?
    private var modified: [String: Date] = [:]
    private var aboutModified: [String: Date] = [:]
    private var watchTask: Task<Void, Never>?

    public init(folder: URL, launcher: @escaping AgentLauncher) {
        self.folder = folder
        self.launcher = launcher
        seedDefaults()
        rescan()
        jobs = loadJobs()
    }

    /// Something the component team did that you have not looked at yet.
    public var hasUnseenWork: Bool {
        jobs.contains { !$0.seen && !$0.isWorking }
    }

    public func markJobsSeen() {
        guard jobs.contains(where: { !$0.seen && !$0.isWorking }) else { return }
        for index in jobs.indices where !jobs[index].isWorking { jobs[index].seen = true }
        saveJobs()
    }

    private var jobsURL: URL { folder.appending(path: "jobs.json") }

    private func loadJobs() -> [ComponentJob] {
        guard let data = try? Data(contentsOf: jobsURL),
              var jobs = try? JSONDecoder().decode([ComponentJob].self, from: data) else { return [] }
        // A job left running when Deck quit did not finish.
        for index in jobs.indices where jobs[index].isWorking {
            jobs[index].finishedAt = jobs[index].startedAt
            jobs[index].summary = jobs[index].summary ?? "Deck 關掉時還沒做完。"
            jobs[index].activity = nil
        }
        return jobs
    }

    private func saveJobs() {
        guard let data = try? JSONEncoder().encode(Array(jobs.suffix(100))) else { return }
        try? data.write(to: jobsURL, options: .atomic)
    }

    private func updateJob(_ id: UUID, _ change: (inout ComponentJob) -> Void) {
        guard let index = jobs.firstIndex(where: { $0.id == id }) else { return }
        change(&jobs[index])
        saveJobs()
    }

    // MARK: Reading

    public func templateURL(_ name: String) -> URL {
        folder.appending(path: "\(name)/template.html")
    }

    public func template(_ name: String) -> String? {
        try? String(contentsOf: templateURL(name), encoding: .utf8)
    }

    public func hasPrevious(_ name: String) -> Bool {
        FileManager.default.fileExists(atPath: previousURL(name).path)
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
        folder.appending(path: "\(name)/about.md")
    }

    // MARK: Changing

    /// Asks the component team to change `name` (or make it, if it does not exist yet).
    public func request(_ name: String, change: String, from asker: String) {
        let name = Self.safeName(name)
        guard !name.isEmpty, working[name] == nil else { return }
        let componentFolder = folder.appending(path: name)
        try? FileManager.default.createDirectory(at: componentFolder, withIntermediateDirectories: true)
        if FileManager.default.fileExists(atPath: templateURL(name).path) {
            try? FileManager.default.removeItem(at: previousURL(name))
            try? FileManager.default.copyItem(at: templateURL(name), to: previousURL(name))
        }

        let process: AgentProcess
        do {
            process = try launcher(AgentLaunch(
                model: .haiku,
                sessionID: UUID(),
                workingDirectory: componentFolder,
                systemPrompt: ComponentPrompts.system,
                tools: ["Read", "Write", "Edit"]
            ))
        } catch {
            onChanged?(name, "組件團隊拉不起來：\(error.localizedDescription)")
            return
        }
        working[name] = change
        let job = ComponentJob(id: UUID(), name: name, request: change, asker: asker, startedAt: Date(), seen: false)
        jobs.append(job)
        saveJobs()
        process.send(ComponentPrompts.task(name: name, change: change, asker: asker, exists: template(name) != nil || hasPrevious(name)))
        Task { [weak self] in
            var summary = ""
            for await event in process.events {
                switch event {
                case let .activity(line):
                    self?.updateJob(job.id) { $0.activity = line }
                case let .reply(text, _):
                    guard summary.isEmpty else { continue }
                    summary = ReplyParser.parseAll(text).body
                    process.finish()
                case .exited:
                    break
                }
            }
            guard let self else { return }
            working[name] = nil
            rescan()
            updated.insert(name)
            let result = summary.isEmpty ? "改好了。" : summary
            updateJob(job.id) {
                $0.summary = result
                $0.activity = nil
                $0.finishedAt = Date()
            }
            onChanged?(name, result)
        }
        Task {
            try? await Task.sleep(for: .seconds(900))
            process.stop()
        }
    }

    /// Puts back the version from before the last change.
    public func revert(_ name: String) {
        guard hasPrevious(name) else { return }
        try? FileManager.default.removeItem(at: templateURL(name))
        try? FileManager.default.moveItem(at: previousURL(name), to: templateURL(name))
        updated.remove(name)
        rescan()
    }

    // MARK: Watching

    /// Picks up template edits made by the component team or by hand.
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
        let entries = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
        let found = entries
            .filter { FileManager.default.fileExists(atPath: $0.appending(path: "template.html").path) }
            .map(\.lastPathComponent)
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
                if modified[name] != nil { versions[name, default: 0] += 1 }
                modified[name] = date
            }
            let aboutDate = (try? FileManager.default.attributesOfItem(atPath: aboutURL(name).path)[.modificationDate]) as? Date
            if aboutModified[name] != aboutDate {
                if aboutModified.keys.contains(name) { catalogChanged = true }
                aboutModified[name] = aboutDate
            }
        }
        if catalogChanged { onCatalogChanged?() }
    }

    // MARK: Setup

    private func previousURL(_ name: String) -> URL {
        folder.appending(path: "\(name)/template.prev.html")
    }

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

enum ComponentPrompts {
    static let system = """
    你是 Deck 的組件團隊。你負責對話裡的一個組件，就是目前資料夾的 template.html，用法寫在 about.md。
    - template.html 是一段 HTML（可以有 <style> 和 <script>），畫在深色背景 #1B1B1F 上，寬度跟著外框，高度跟著內容。
    - 資料在 window.deck.data。使用者回答一律呼叫 deck.answer(...)：給數字是選第幾個選項（從 0 開始），給文字是使用者自己打的回答（例如「其他」輸入框）。App 兩種都會當成已回答，並把答案轉給問問題的 bot。
    - 選擇題類的資料裡，chosen 是已選的第幾個、answer 是自己打的回答；任一個不是 null 就代表答過了，要顯示答案並停用按鈕。
    - 文字顏色 #EDEDF0、次要文字 #A0A0A8、強調藍 #4C8DFF、建議橘 #F7C27F；字型用 -apple-system, "PingFang TC", sans-serif。
    - 不要載入任何外部資源。用真的 <button> 和 <input>，按鈕高度至少 44px，對比要夠。
    - 使用者用中文輸入法打字：按 Enter 送出前一定要檢查 event.isComposing，選字時的 Enter 不能送出。
    - about.md 是給所有 bot 看的使用說明，它們只靠這份檔案學怎麼用你的組件：第一行一句話說這是什麼，接著寫資料格式（附一個範例 JSON）和使用者回答時 bot 會收到什麼。只要格式或回答方式有變，就一定要更新 about.md。
    - 只改這個資料夾裡的檔案。改完只回一句話，說你改了什麼。
    """

    static func task(name: String, change: String, asker: String, exists: Bool) -> String {
        exists
            ? "（App：\(asker) 對組件「\(name)」的要求）\n\(change)"
            : "（App：\(asker) 要一個新組件「\(name)」。這個資料夾還是空的，請建立 template.html 和 about.md。）\n\(change)"
    }
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
