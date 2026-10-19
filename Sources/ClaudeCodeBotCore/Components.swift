import Combine
import Foundation

/// A component drawn in a chat message, with the data it was given.
public struct ComponentInstance: Codable, Equatable, Sendable {
    public var name: String
    /// JSON for `window.ccb.data`.
    public var data: String

    public init(name: String, data: String) {
        self.name = name
        self.data = data
    }
}

/// The parts of ClaudeCodeBot's chat that are HTML templates instead of fixed code: one folder each,
/// holding `template.html` and `about.md` (what data it takes). They live in the `ccb-components`
/// plugin (`~/.claudecodebot/plugins/ccb-components/components/<name>/`); other plugins can bring more.
/// Changes are asked of Maintainer; ClaudeCodeBot notices the file change and redraws without a restart.
/// Earlier versions are in the plugin library's git history.
@MainActor
public final class ComponentLibrary: ObservableObject {
    /// Bumps when a template changes on disk, so views reload it.
    @Published public private(set) var versions: [String: Int] = [:]
    /// Components being changed now, with what was asked.
    @Published public private(set) var working: [String: String] = [:]
    /// Changed since ClaudeCodeBot started (shows "Updated" beside them).
    @Published public private(set) var updated: Set<String> = []
    @Published public private(set) var names: [String] = []

    /// Where new components are made: the ccb-components plugin.
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
                let answer = await blocking { git.hasPrevious(path) }
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
            return "- \(name): \(first)" + (rest.isEmpty ? "" : "\n" + rest)
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

    /// Maintainer was asked to change `name`: show it as being worked on.
    public func markWorking(_ name: String, change: String) {
        working[Self.safeName(name)] = change
    }

    /// Maintainer finished its turn.
    public func finishWorking() {
        guard !working.isEmpty else { return }
        rescan()
        working = [:]
    }

    /// Puts back the version from before the last change (git), then redraws.
    @discardableResult
    public func revert(_ name: String) async -> String? {
        guard let git, let path = gitPath(name) else { return "This component has no version history." }
        let problem = await blocking { git.revert(path, label: "component \(name)") }
        updated.remove(name)
        previous[name] = nil
        rescan()
        return problem
    }

    // MARK: Watching

    /// Picks up template edits made by Maintainer or by hand.
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

/// How a component is written; the ccb-core:component-editor agent's instructions.
enum ComponentPrompts {
    static let system = """
    You are ClaudeCodeBot's component editor (component-editor). You look after one component in the chat: its folder holds template.html, and how to use it is written in about.md.
    - template.html is a piece of HTML (it may include <style> and <script>), drawn on the dark background #1B1B1F; its width follows the frame and its height follows the content.
    - The data is in window.ccb.data. The user's answer always calls ccb.answer(...): a number picks an option by index (from 0), text is an answer the user typed (for example an "Other" input box). The app treats both as answered and passes the answer to the bot that asked.
    - In choice-style data, chosen is the index already picked and answer is a typed answer; if either is not null the question is answered, so show the answer and disable the buttons.
    - Text color #EDEDF0, secondary text #A0A0A8, accent blue #4C8DFF, recommended orange #F7C27F; font -apple-system, "PingFang TC", sans-serif.
    - Do not load any outside resources. Use real <button> and <input> elements, buttons at least 44px tall, with enough contrast.
    - The user may type with an input method (IME, e.g. for Chinese): always check event.isComposing before sending on Enter; an Enter that picks a candidate must not send.
    - about.md is the usage guide every bot reads; it is the only way they learn to use your component: the first line says in one sentence what it is, then the data format (with an example JSON) and what the bot receives when the user answers. Whenever the format or the way of answering changes, you must update about.md.
    - Only change files in that component's folder and do not commit (whoever handed you the job checks and commits). When done, reply with one sentence saying what you changed.
    """
}

/// The templates ClaudeCodeBot ships with; written to `~/.claudecodebot/components/` the first time.
enum ComponentDefaults {
    /// Earlier shipped versions, replaced on launch only if still unedited. Older builds shipped
    /// them in Chinese; the Chinese text below is kept on purpose, as data, so that an unedited
    /// file from an older build is recognised and brought up to date. Do not translate it.
    static let olderChoicesAbouts = ["""
    選擇題：一排按鈕讓使用者選一個，建議的那個會標出來。
    資料：{"options":[{"label":"用預設圖補上","detail":"今天做完","recommended":true},{"label":"先留白","detail":null,"recommended":false}],"chosen":null}
    chosen 是已選的第幾個（從 0 開始），還沒選是 null。按下第 i 個時呼叫 ccb.choose(i)。
    """, """
    選擇題：一排按鈕讓使用者選一個，建議的那個會標出來。bot 不用直接畫它：在回覆最後寫 <choices> 區塊，App 就會用這個組件。
    資料：{"options":[{"label":"用預設圖補上","detail":"今天做完","recommended":true},{"label":"先留白","detail":null,"recommended":false}],"chosen":null,"answer":null}
    chosen 是已選的第幾個（從 0 開始），answer 是使用者自己打的回答，都還沒有就是 null。
    使用者回答時，bot 會收到他選的那一項文字，或他自己打的字。
    """]

    static var olderChoicesTemplates: [String] {
        // Older builds shipped the same markup with Chinese labels (kept as data, see above).
        let chinese = choicesTemplate
            .replacingOccurrences(of: "'Recommended · '", with: "'建議 · '")
            .replacingOccurrences(of: ": 'Recommended')", with: ": '建議')")
        return [chinese, chinese
            .replacingOccurrences(of: "button.addEventListener('click', () => ccb.answer(index));", with: "button.addEventListener('click', () => ccb.choose(index));")
            .replacingOccurrences(of: "button.disabled = data.chosen != null || data.answer != null;", with: "button.disabled = data.chosen != null;")
            .replacingOccurrences(of: "+ ((data.chosen != null || data.answer != null) && !picked ? ' faded' : '');", with: "+ (data.chosen != null && !picked ? ' faded' : '');")]
    }

    static let choicesAbout = """
    Choices: a row of buttons for the user to pick one; the recommended one is marked. Bots do not draw it directly: end the reply with a <choices> block and the app uses this component.
    Data: {"options":[{"label":"Fill in with a placeholder image","detail":"Done today","recommended":true},{"label":"Leave it blank for now","detail":null,"recommended":false}],"chosen":null,"answer":null}
    chosen is the index picked (from 0), answer is an answer the user typed; both are null until answered.
    When the user answers, the bot receives the text of the option picked, or what the user typed.
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
      const data = window.ccb.data;
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
            ? (option.detail ? 'Recommended · ' + option.detail : 'Recommended')
            : (option.detail || '');
        }
        button.append(label, side);
        button.addEventListener('click', () => ccb.answer(index));
        list.append(button);
      });
    </script>
    """
}
