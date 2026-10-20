import Combine
import Foundation

/// A component drawn in a chat message, with the data it was given.
public struct ComponentInstance: Codable, Equatable, Sendable {
    public var name: String
    /// JSON for `window.ccb.data`.
    public var data: String
    /// Where in the message's text it is drawn (a UTF-16 offset); nil: after the text.
    public var at: Int?
    /// A shell command whose output is the data instead (`<show name="x" command="git diff --stat">`),
    /// run in the bot's project folder once the user allows it. See `ComponentCommands`.
    public var command: String?

    public init(name: String, data: String, at: Int? = nil, command: String? = nil) {
        self.name = name
        self.data = data
        self.at = at
        self.command = command
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
        catalog(names)
    }

    private func catalog(_ names: [String]) -> String {
        names.map { name in
            let about = ((try? String(contentsOf: aboutURL(name), encoding: .utf8)) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let lines = about.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            let first = lines.first ?? ""
            let rest = lines.dropFirst().map { "  " + $0 }.joined(separator: "\n")
            return "- \(name): \(first)" + (rest.isEmpty ? "" : "\n" + rest)
        }.joined(separator: "\n")
    }

    /// The catalog lines of just these components.
    public func catalog(of only: [String]) -> String {
        let wanted = Set(only)
        return catalog(names.filter(wanted.contains))
    }

    /// The components `text` names with /Name (the user picked one from the input box's list),
    /// in the order they are named.
    public func mentioned(in text: String) -> [String] {
        ComponentMentions.names(in: text, among: names)
    }

    /// What goes to the bot, unseen, with a message that names components with /.
    public func mentionNote(for text: String) -> String? {
        let named = mentioned(in: text)
        guard !named.isEmpty else { return nil }
        let list = named.map { "\"\($0)\"" }.joined(separator: ", ")
        return "(App: With / the user names the in-chat component\(named.count == 1 ? "" : "s") \(list): they mean \(named.count == 1 ? "that component" : "those components") of the app's chat. <show name=\"name\">JSON</show> draws one; <component name=\"name\">request</component> asks Maintainer to change one. How to use \(named.count == 1 ? "it" : "them"):\n\(catalog(of: named)))"
    }

    /// The command a component takes its data from, when its about.md has a line
    /// `Command: npx ccusage daily --json` (backticks around it are fine). A `<show>` of it
    /// with no JSON and no command of its own runs this one (see `ComponentCommands`).
    public func command(of name: String) -> String? {
        guard let about = try? String(contentsOf: aboutURL(name), encoding: .utf8) else { return nil }
        return Self.command(inAbout: about)
    }

    static func command(inAbout about: String) -> String? {
        for line in about.split(separator: "\n") {
            var text = line.trimmingCharacters(in: .whitespaces)
            if text.hasPrefix("- ") || text.hasPrefix("* ") { text = String(text.dropFirst(2)) }
            guard text.lowercased().hasPrefix("command:") else { continue }
            let command = text.dropFirst("command:".count)
                .trimmingCharacters(in: .whitespaces)
                .trimmingCharacters(in: CharacterSet(charactersIn: "`"))
                .trimmingCharacters(in: .whitespaces)
            if !command.isEmpty { return command }
        }
        return nil
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
        let defaults = [
            ("choices", ComponentDefaults.choicesTemplate, ComponentDefaults.choicesAbout, ComponentDefaults.olderChoicesTemplates, ComponentDefaults.olderChoicesAbouts),
            (PagePreview.component, ComponentDefaults.previewTemplate, ComponentDefaults.previewAbout, [], [])
        ]
        for (name, template, about, olderTemplates, olderAbouts) in defaults {
            let componentFolder = folder.appending(path: name)
            try? FileManager.default.createDirectory(at: componentFolder, withIntermediateDirectories: true)
            for (file, text, older) in [
                ("template.html", template, olderTemplates),
                ("about.md", about, olderAbouts)
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

/// Components named with / in what the user typed (the input box offers them after /, with
/// the app's commands; @ is for bots).
public enum ComponentMentions {
    /// The names `text` has as `/name`, in the order they come. Longer names win, so a name that
    /// starts another is not read inside it. The slash starts a word (after a space, a bracket or
    /// quote, or non-ASCII text such as Chinese), so "用/網頁預覽卡片" counts but "a/choices" and
    /// "~/choices" (paths) do not; only ASCII letters, digits, _, - and / end a name.
    public static func names(in text: String, among names: [String]) -> [String] {
        let lower = text.lowercased()
        let wordCharacter = { (c: Character) in c.isASCII && (c.isLetter || c.isNumber || c == "_" || c == "-" || c == "/") }
        let startsAfter = { (c: Character) in !c.isASCII || c.isWhitespace || "([{\"'".contains(c) }
        var found: [(at: String.Index, name: String)] = []
        var taken: [Range<String.Index>] = []
        for name in Set(names).sorted(by: { $0.count > $1.count }) where !name.isEmpty {
            let needle = "/" + name.lowercased()
            var from = lower.startIndex
            while let range = lower.range(of: needle, range: from..<lower.endIndex) {
                from = range.upperBound
                let startsWord = range.lowerBound == lower.startIndex || startsAfter(lower[lower.index(before: range.lowerBound)])
                let endsWord = range.upperBound == lower.endIndex || !wordCharacter(lower[range.upperBound])
                guard startsWord, endsWord, !taken.contains(where: { $0.overlaps(range) }) else { continue }
                taken.append(range)
                if !found.contains(where: { $0.name == name }) { found.append((range.lowerBound, name)) }
            }
        }
        return found.sorted { $0.at < $1.at }.map(\.name)
    }
}

/// The app's / commands, offered in the input box with the components. The bots' rules (see
/// `BotPrompts`) say what each means; the command stays in the text the bot reads.
public enum SlashCommands {
    public struct Command: Encodable, Equatable, Sendable {
        public let name: String
        public let about: String
    }

    public static let all = [
        Command(name: "design", about: "Make a Claude Design and get its claude.ai link"),
    ]
}

/// How a component is written; the ccb-core:component-editor agent's instructions.
enum ComponentPrompts {
    static let system = """
    You are ClaudeCodeBot's component editor (component-editor). You look after one component in the chat: its folder holds template.html, and how to use it is written in about.md.
    - template.html is a piece of HTML (it may include <style> and <script>), drawn on the dark background #1B1B1F; its width follows the frame and its height follows the content.
    - The data is in window.ccb.data. The user's answer always calls ccb.answer(...): a number picks an option by index (from 0), text is an answer the user typed (for example an "Other" input box). The app treats both as answered and passes the answer to the bot that asked.
    - Pictures back: ccb.answer({text, images}) sends words with pictures; images are what ccb.pickImage({multiple: true}) resolves to (call it from a click; [] if cancelled), what ccb.readImage(file) makes of a pasted or dropped File, or data: URLs. Each picked picture has dataURL for a thumbnail. The bot gets the pictures as saved files, like pictures sent with a message.
    - Codex review: ccb.reviewWithCodex({scope, commit, spec}) has Codex review the chat bot's repository once, read-only; scope is "uncommitted", "lastCommit", "branch" (against main or master, only off those) or "commit" (commit: a hash in the repository; a commit alone implies it); spec is an optional .md/.txt/.html file in the bot's folder or home that Codex checks the change against. Call it from a click. The report shows in the right column and a line in the chat; a call the app cannot check is ignored.
    - Pictures shown: when the data names a local picture by file path, set img.src = ccb.image(path) (a file: URL does not load in the frame); ccb.image returns "" for a file that is not there.
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
    """, """
    Choices: a row of buttons for the user to pick one; the recommended one is marked. Bots do not draw it directly: end the reply with a <choices> block and the app uses this component.
    Data: {"options":[{"label":"Fill in with a placeholder image","detail":"Done today","recommended":true},{"label":"Leave it blank for now","detail":null,"recommended":false}],"chosen":null,"answer":null}
    chosen is the index picked (from 0), answer is an answer the user typed; both are null until answered.
    When the user answers, the bot receives the text of the option picked, or what the user typed.
    """]

    static var olderChoicesTemplates: [String] {
        // Older builds shipped the same markup with Chinese labels (kept as data, see above).
        let chinese = choicesTemplateV1
            .replacingOccurrences(of: "'Recommended · '", with: "'建議 · '")
            .replacingOccurrences(of: ": 'Recommended')", with: ": '建議')")
        return [choicesTemplateV1, chinese, chinese
            .replacingOccurrences(of: "button.addEventListener('click', () => ccb.answer(index));", with: "button.addEventListener('click', () => ccb.choose(index));")
            .replacingOccurrences(of: "button.disabled = data.chosen != null || data.answer != null;", with: "button.disabled = data.chosen != null;")
            .replacingOccurrences(of: "+ ((data.chosen != null || data.answer != null) && !picked ? ' faded' : '');", with: "+ (data.chosen != null && !picked ? ' faded' : '');")]
    }

    static let choicesAbout = """
    Choices: a row of buttons for the user to pick one; the recommended one is marked, and an "Other" box at the end takes the user's own words and pictures. Bots do not draw it directly: end the reply with a <choices> block and the app uses this component.
    Data: {"options":[{"label":"Fill in with a placeholder image","detail":"Done today","recommended":true},{"label":"Leave it blank for now","detail":null,"recommended":false}],"chosen":null,"answer":null}
    options lists only the choices; the component adds "Other" itself. chosen is the index picked (from 0), answer is an answer the user typed; both are null until answered.
    When the user answers, the bot receives the text of the option picked, or what the user wrote in "Other"; pictures attached there come as saved files listed under (Attachments: …), like pictures sent with a message.
    """

    /// The choices template up to 1.5 (buttons only, no "Other" box).
    static let choicesTemplateV1 = """
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
      .option.faded, .other.faded { opacity: 0.4; }
      .option:disabled { cursor: default; }
      .detail { font-size: 12px; color: #A0A0A8; white-space: nowrap; }
      .recommended .detail { color: #F7C27F; }
      .check { color: #4C8DFF; font-weight: 600; }
      .other { display: flex; flex-direction: column; gap: 8px; padding: 8px; border-radius: 12px; border: 1px solid #303037; background: #232328; }
      .other.dropping, .other:focus-within { border-color: #4C8DFF; }
      .other.picked { border-color: #4C8DFF; background: #1E2A44; }
      .row { display: flex; gap: 8px; align-items: center; }
      .other input[type=text] {
        flex: 1; min-width: 0; min-height: 44px; padding: 0 10px; box-sizing: border-box;
        border: 0; border-radius: 8px; background: transparent; color: #EDEDF0; font: inherit; font-size: 14px; outline: none;
      }
      .other input::placeholder { color: #A0A0A8; }
      .other button {
        flex: none; min-width: 44px; min-height: 44px; padding: 0 12px; border-radius: 10px;
        border: 1px solid #303037; background: #1B1B1F; color: #EDEDF0; font: inherit; font-size: 13px; cursor: pointer;
      }
      .other button.send { border-color: #2F4F8F; background: #1E2A44; }
      .other button:disabled { opacity: 0.4; cursor: default; }
      .pictures { display: flex; flex-wrap: wrap; gap: 6px; }
      .pictures:empty { display: none; }
      .picture { position: relative; }
      .picture img { display: block; width: 64px; height: 64px; object-fit: cover; border-radius: 8px; border: 1px solid #303037; }
      .picture .remove { position: absolute; top: -6px; right: -6px; min-width: 22px; min-height: 22px; padding: 0; border-radius: 11px; font-size: 13px; line-height: 1; }
    </style>
    <div class="list" id="list"></div>
    <script>
      const data = window.ccb.data;
      const list = document.getElementById('list');
      const answered = data.chosen != null || data.answer != null;
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

      // "Other": words, pictures (attach, paste or drop), or both.
      const other = document.createElement('div');
      other.className = 'other' + (data.answer != null ? ' picked' : '') + (data.chosen != null ? ' faded' : '');
      const row = document.createElement('div');
      row.className = 'row';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Other… (paste or drop a picture too)';
      input.setAttribute('aria-label', 'Other answer');
      input.value = data.answer || '';
      const attach = document.createElement('button');
      attach.className = 'attach';
      attach.textContent = 'Picture';
      attach.setAttribute('aria-label', 'Attach a picture');
      const send = document.createElement('button');
      send.className = 'send';
      send.textContent = 'Send';
      const strip = document.createElement('div');
      strip.className = 'pictures';
      row.append(input, attach, send);
      other.append(row, strip);
      list.append(other);

      const pictures = [];
      let sent = false;
      const refresh = () => {
        const off = answered || sent;
        input.disabled = off;
        attach.disabled = off;
        send.disabled = off || (!input.value.trim() && pictures.length === 0);
        strip.querySelectorAll('.remove').forEach((button) => { button.disabled = off; });
      };
      const add = (picture) => {
        pictures.push(picture);
        const item = document.createElement('div');
        item.className = 'picture';
        const img = document.createElement('img');
        img.src = picture.dataURL;
        img.alt = picture.name;
        const remove = document.createElement('button');
        remove.className = 'remove';
        remove.textContent = '×';
        remove.setAttribute('aria-label', 'Remove picture');
        remove.addEventListener('click', () => {
          pictures.splice(pictures.indexOf(picture), 1);
          item.remove();
          refresh();
        });
        item.append(img, remove);
        strip.append(item);
        refresh();
      };
      const addFiles = (files) => {
        [...files].filter((file) => file.type.startsWith('image/')).forEach((file) => ccb.readImage(file).then(add));
      };
      const submit = () => {
        const text = input.value.trim();
        if (answered || sent || (!text && pictures.length === 0)) return;
        sent = true;
        refresh();
        ccb.answer(pictures.length ? { text, images: pictures } : text);
      };
      attach.addEventListener('click', () => ccb.pickImage({ multiple: true }).then((picked) => picked.forEach(add)));
      send.addEventListener('click', submit);
      input.addEventListener('input', refresh);
      input.addEventListener('keydown', (event) => {
        if (event.isComposing || event.keyCode === 229 || event.key !== 'Enter') return;
        event.preventDefault();
        submit();
      });
      input.addEventListener('paste', (event) => {
        const files = [...((event.clipboardData && event.clipboardData.files) || [])];
        if (!files.some((file) => file.type.startsWith('image/'))) return;
        event.preventDefault();
        addFiles(files);
      });
      other.addEventListener('dragover', (event) => {
        if (answered || sent || !event.dataTransfer || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        other.classList.add('dropping');
      });
      other.addEventListener('dragleave', () => other.classList.remove('dropping'));
      other.addEventListener('drop', (event) => {
        other.classList.remove('dropping');
        if (answered || sent || !event.dataTransfer || !event.dataTransfer.files.length) return;
        event.preventDefault();
        addFiles(event.dataTransfer.files);
      });
      refresh();
    </script>
    """

    /// 「網頁預覽卡片」: written in Traditional Chinese like the user's own components.
    static let previewAbout = """
    網頁預覽卡片：把一頁式 HTML 結果直接縮小預覽在對話裡，附上標題和「開啟」按鈕，按下就用自己的視窗開成全尺寸。用 `<show name="網頁預覽卡片">JSON</show>` 叫出來。

    ## 資料格式（window.ccb.data）

    ```json
    {
      "path": "/Users/me/project/.bot/artifacts/competitor-report.html",
      "title": "競品比較報告"
    }
    ```

    - `path`：HTML 檔的完整路徑，也可以寫 `file://` 網址或 `~/` 開頭的路徑。
    - `title`：卡片上的標題；省略時用檔名。
    - `src`、`url`、`name`、`missing` 由 App 自己補上，不用寫。檔案不存在時卡片會顯示「找不到這個檔案」。

    ## 什麼時候用

    - 回覆裡連到 `artifacts` 資料夾裡 .html 的連結，例如 `[競品比較](file:///…/.bot/artifacts/report.html)`，App 會自動畫成這張卡片，照常附連結就好，不必另外寫 `<show>`。
    - 想換卡片標題，或頁面不在 `artifacts` 資料夾時，才用 `<show>`。不在 `artifacts` 裡的頁面只會載入那一個檔案，旁邊的圖片不會顯示。
    - 一則回覆可以有好幾個 `<show>`，各自畫在寫的位置。
    - 不需要使用者回答，不會呼叫 `ccb.answer`。
    """

    static let previewTemplate = """
    <style>
      :root { --bg:#232328; --line:#303037; --text:#EDEDF0; --muted:#A0A0A8; --accent:#4C8DFF; --button:#1E2A44; --button-line:#2F4F8F; --empty:#1B1B1F; }
      @media (prefers-color-scheme: light) {
        :root { --bg:#FFFFFF; --line:#DCDCE3; --text:#1D1D22; --muted:#6A6A74; --accent:#2F6FE0; --button:#EAF1FF; --button-line:#B9CEF5; --empty:#F4F4F7; }
      }
      .card { box-sizing:border-box; width:100%; max-width:480px; border-radius:14px; border:1px solid var(--line); background:var(--bg); color:var(--text); overflow:hidden; }
      .shot { position:relative; display:block; width:100%; height:270px; overflow:hidden; background:#FFFFFF; border-bottom:1px solid var(--line); cursor:pointer; }
      .shot:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
      .shot iframe { position:absolute; top:0; left:0; width:1280px; height:800px; border:0; background:#FFFFFF; transform-origin:0 0; pointer-events:none; }
      .empty { display:flex; align-items:center; justify-content:center; height:96px; padding:0 16px; background:var(--empty); color:var(--muted); font-size:13px; text-align:center; border-bottom:1px solid var(--line); }
      .foot { display:flex; align-items:center; gap:12px; padding:8px 8px 8px 14px; }
      .names { flex:1; min-width:0; }
      .title { font-size:14px; font-weight:600; line-height:1.35; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .file { margin-top:2px; font-size:12px; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .open { flex:none; min-height:44px; padding:0 14px; border-radius:10px; border:1px solid var(--button-line); background:var(--button); color:var(--text); font:inherit; font-size:13px; cursor:pointer; }
      .open:disabled { opacity:0.45; cursor:default; }
    </style>
    <div class="card" id="card"></div>
    <script>
      const data = window.ccb.data || {};
      const card = document.getElementById('card');
      // The page is drawn at a desktop width, then scaled down to the card.
      const pageWidth = 1280, pageHeight = 800;
      const title = data.title || data.name || '網頁預覽';
      const canOpen = !!data.url && !data.missing;
      const open = () => { if (canOpen) ccb.open(data.url, title); };

      if (data.src && !data.missing) {
        const shot = document.createElement('div');
        shot.className = 'shot';
        shot.tabIndex = 0;
        shot.setAttribute('role', 'button');
        shot.setAttribute('aria-label', '開啟完整頁面：' + title);
        const frame = document.createElement('iframe');
        frame.src = data.src;
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('aria-hidden', 'true');
        frame.tabIndex = -1;
        shot.append(frame);
        shot.addEventListener('click', open);
        shot.addEventListener('keydown', (event) => {
          if (event.isComposing) return;
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
        });
        card.append(shot);
        const fit = () => {
          const scale = shot.clientWidth / pageWidth;
          if (!scale) return;
          frame.style.transform = 'scale(' + scale + ')';
          shot.style.height = Math.round(pageHeight * scale) + 'px';
        };
        new ResizeObserver(fit).observe(card);
        fit();
      } else {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = data.missing ? '找不到這個檔案' : '這個頁面無法預覽';
        card.append(empty);
      }

      const foot = document.createElement('div');
      foot.className = 'foot';
      const names = document.createElement('div');
      names.className = 'names';
      const heading = document.createElement('div');
      heading.className = 'title';
      heading.textContent = title;
      names.append(heading);
      if (data.name && data.name !== title) {
        const file = document.createElement('div');
        file.className = 'file';
        file.textContent = data.name;
        names.append(file);
      }
      const button = document.createElement('button');
      button.className = 'open';
      button.textContent = '開啟完整頁面';
      button.disabled = !canOpen;
      button.addEventListener('click', open);
      foot.append(names, button);
      card.append(foot);
    </script>
    """
}
