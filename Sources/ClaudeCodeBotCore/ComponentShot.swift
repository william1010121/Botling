import Foundation

/// `ClaudeCodeBot --component-shot <component folder>`: draws one component the way this build of
/// the app draws it, in the real chat page, on every surface (in a chat reply, as Board tiles of
/// several sizes, opened above the input box, floating in a corner), takes pictures, and reports
/// what is wrong: script errors, failed `ccb` calls, missing resources, content wider than its
/// frame, and frames that draw nothing. The drawing is in the app (`ComponentShotRun`); what is
/// measured, how it is judged and how it is reported is here, so it can be tested.
public enum ComponentShot {
    public static let flag = "--component-shot"

    public enum Surface: String, CaseIterable, Codable, Sendable {
        case chat, board, pinned, floating
    }

    /// The Board sizes shot when neither `--sizes` nor the about.md `Sizes:` line names others:
    /// the smallest, a wide strip, the default and the chat's widest.
    public static let defaultSizes: [PinnedComponent.Size] = [.small, .wide, .large, .extraLarge]

    public struct Options: Equatable, Sendable {
        public var component: URL
        public var out: URL
        public var data: URL?
        /// The project folder its about.md `Command:` runs in; without it the command is not run.
        public var folder: URL?
        public var surfaces: [Surface]
        /// Board sizes; nil: `defaultSizes` plus the about.md hints.
        public var sizes: [PinnedComponent.Size]?
        public var theme: String
    }

    public static func isRequested(_ arguments: [String] = CommandLine.arguments) -> Bool {
        arguments.contains(flag)
    }

    public static let usage = """
    Usage: ClaudeCodeBot --component-shot <component folder> [--out <dir>] [--data <file.json>] [--folder <project dir>]
                         [--surfaces chat,board,pinned,floating] [--sizes 1x1,2x1,2x2,4x2 | all] [--theme dark]
    Draws the component in this build's real chat page on each surface, saves a picture of each
    and a contact sheet, and lists what is wrong. Exit 0: no problems, 1: problems, 2: bad usage.
    Data: --data, else its Command run in --folder, else about.md's example (```json block or Data: line), else null.
    A Command: line in about.md is always run once as written (in --folder, else the plugin folder); a failure is a problem.
    """

    /// Reads the command line. `cwd` resolves relative paths.
    public static func parse(_ arguments: [String], cwd: URL = URL(filePath: FileManager.default.currentDirectoryPath)) -> Result<Options, ShotError> {
        guard let at = arguments.firstIndex(of: flag), at + 1 < arguments.count, !arguments[at + 1].hasPrefix("--") else {
            return .failure(.usage("Name the component folder (the one with template.html)."))
        }
        let path = { (text: String) in (text.hasPrefix("/") ? URL(filePath: text) : cwd.appending(path: text)).standardizedFileURL }
        let component = path(arguments[at + 1])
        var options = Options(
            component: component,
            out: FileManager.default.temporaryDirectory.appending(path: "ccb-shot-\(component.lastPathComponent)-\(Int(Date().timeIntervalSince1970))"),
            data: nil, folder: nil, surfaces: Surface.allCases, sizes: nil, theme: "dark")
        var index = at + 2
        while index < arguments.count {
            let flag = arguments[index]
            guard ["--out", "--data", "--folder", "--surfaces", "--sizes", "--theme"].contains(flag) else { index += 1; continue }
            guard index + 1 < arguments.count else { return .failure(.usage("\(flag) needs a value.")) }
            let value = arguments[index + 1]
            switch flag {
            case "--out": options.out = path(value)
            case "--data": options.data = path(value)
            case "--folder": options.folder = path(value)
            case "--surfaces":
                var surfaces: [Surface] = []
                for part in value.split(separator: ",") {
                    let name = part.trimmingCharacters(in: .whitespaces).lowercased()
                    guard let surface = Surface(rawValue: name) else { return .failure(.usage("Unknown surface \(name): chat, board, pinned or floating.")) }
                    if !surfaces.contains(surface) { surfaces.append(surface) }
                }
                guard !surfaces.isEmpty else { return .failure(.usage("--surfaces names none.")) }
                options.surfaces = surfaces
            case "--sizes":
                if value.lowercased() == "all" {
                    options.sizes = PinnedComponent.Size.all
                } else {
                    var sizes: [PinnedComponent.Size] = []
                    for part in value.split(separator: ",") {
                        guard let size = PinnedComponent.Size(spelled: String(part)) else { return .failure(.usage("Not a Board size: \(part) (\(PinnedComponent.Size.rangeText)).")) }
                        if !sizes.contains(size) { sizes.append(size) }
                    }
                    guard !sizes.isEmpty else { return .failure(.usage("--sizes names none.")) }
                    options.sizes = sizes
                }
            default:
                options.theme = value.lowercased()
            }
            index += 2
        }
        guard options.theme == "dark" else {
            return .failure(.unsupported("The app only draws components in the dark theme (its window and every component frame are dark), so there is no \(options.theme) theme to shoot."))
        }
        guard FileManager.default.fileExists(atPath: component.appending(path: "template.html").path) else {
            return .failure(.usage("No template.html in \(component.path)."))
        }
        return .success(options)
    }

    public enum ShotError: Error, Equatable, CustomStringConvertible {
        case usage(String)
        case unsupported(String)

        public var description: String {
            switch self {
            case let .usage(text): "\(text)\n\n\(ComponentShot.usage)"
            case let .unsupported(text): text
            }
        }
    }

    /// The Board sizes to shoot: those asked for, else the defaults followed by any its about.md hints.
    public static func sizes(asked: [PinnedComponent.Size]?, hinted: [PinnedComponent.Size]) -> [PinnedComponent.Size] {
        if let asked { return asked }
        var sizes = defaultSizes
        for size in hinted where !sizes.contains(size) { sizes.append(size) }
        return sizes
    }

    // MARK: Data

    /// The example a bot is shown in an about.md: its first ```json block that holds valid JSON,
    /// else the first "Data: {…}" (or "Example: …") line whose rest is JSON.
    public static func sampleData(fromAbout about: String) -> String? {
        if let block = jsonBlock(inAbout: about) { return block }
        for line in about.components(separatedBy: "\n") {
            var text = line.trimmingCharacters(in: .whitespaces)
            if text.hasPrefix("- ") || text.hasPrefix("* ") { text = String(text.dropFirst(2)) }
            for label in ["data:", "example:", "example data:", "sample:"] where text.lowercased().hasPrefix(label) {
                let rest = text.dropFirst(label.count).trimmingCharacters(in: CharacterSet(charactersIn: "` ")).trimmingCharacters(in: .whitespaces)
                if rest.hasPrefix("{") || rest.hasPrefix("["), isJSON(rest) { return rest }
            }
        }
        return nil
    }

    static func jsonBlock(inAbout about: String) -> String? {
        var inside = false
        var lines: [String] = []
        for line in about.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if !inside {
                if trimmed.lowercased().hasPrefix("```json") { inside = true; lines = [] }
                continue
            }
            if trimmed.hasPrefix("```") {
                let json = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                if isJSON(json) { return json }
                inside = false
                continue
            }
            lines.append(line)
        }
        return nil
    }

    public static func isJSON(_ text: String) -> Bool {
        !text.isEmpty && (try? JSONSerialization.jsonObject(with: Data(text.utf8), options: .fragmentsAllowed)) != nil
    }

    /// Where the data came from, for the report.
    public enum DataSource: Equatable, Sendable {
        case file(String), command(String), example, none

        public var description: String {
            switch self {
            case let .file(path): "the file \(path)"
            case let .command(command): "its Command (\(command))"
            case .example: "about.md's example"
            case .none: "null (no --data, no Command run, no example in about.md)"
            }
        }
    }

    // MARK: Its Command

    /// How long the check gives a component's Command (the chat gives it `ComponentCommands.timeout`).
    public static let commandCheckTimeout: TimeInterval = 30

    /// Its about.md Command, run once as written.
    public struct CommandCheck: Equatable, Sendable {
        public var command: String
        public var folder: URL
        public var outcome: CommandOutcome
        /// A problem when it fails as the chat would show "The command failed"; a warning when it
        /// only took longer than the check waits.
        public var findings: [Finding]
    }

    /// Where its Command runs when no project folder is given: the plugin folder holding it
    /// (`<plugin>/components/<name>`), else the component's own folder.
    public static func commandFolder(for component: URL) -> URL {
        let parent = component.deletingLastPathComponent()
        return parent.lastPathComponent == "components" ? parent.deletingLastPathComponent() : component
    }

    /// Runs the component's about.md `Command:` line once, verbatim, the way a chat card does
    /// (`ComponentCommands.execute`: the user's zsh, no input, the same output cap) in `folder`
    /// (else `commandFolder`), with a shorter time limit. nil when it has no Command.
    public static func checkCommand(component: URL, folder: URL?, timeout: TimeInterval = commandCheckTimeout) async -> CommandCheck? {
        guard let about = try? String(contentsOf: component.appending(path: "about.md"), encoding: .utf8),
              let command = ComponentLibrary.command(inAbout: about) else { return nil }
        let place = folder ?? commandFolder(for: component)
        let outcome = await ComponentCommands.execute(command, in: place, timeout: timeout, limit: ComponentCommands.outputLimit)
        var findings: [Finding] = []
        if let error = outcome.error {
            let said = error.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: " · ")
            if outcome.timedOut {
                findings.append(Finding(level: .warning, place: "command", text: "Its Command (\(command)) did not finish within \(Int(timeout))s in \(place.path); the chat gives it \(Int(ComponentCommands.timeout))s: \(said)"))
            } else {
                var text = "Its Command failed when run as written (\(command), in \(place.path)): \(said). The app runs the Command: line verbatim with zsh, so it must work exactly as written; describe optional arguments in about.md's prose, not in the line."
                if folder == nil { text += " If it only works in a project, run the shot again with --folder <project folder>." }
                findings.append(Finding(level: .problem, place: "command", text: text))
            }
        }
        return CommandCheck(command: command, folder: place, outcome: outcome, findings: findings)
    }

    // MARK: Measuring

    /// What the probe in a component frame saw (`probeScript`).
    public struct FrameReport: Codable, Equatable, Sendable {
        public var surface: String
        public var size: String
        /// The frame's width and height.
        public var width: Double
        public var height: Double
        /// The document's scroll size: wider than `width` means it is cut off on the right.
        public var scrollWidth: Double
        public var scrollHeight: Double
        /// How tall `#ccb-root`'s content is.
        public var contentHeight: Double
        /// The element reaching furthest right past the frame, and how far it reaches.
        public var widest: String?
        public var widestRight: Double?
        public var hasText: Bool
        public var hasMedia: Bool
        public var errors: [String]
        public var rejections: [String]
        public var console: [String]
        public var ccb: [String]
        public var resources: [String]

        public init(surface: String, size: String, width: Double, height: Double, scrollWidth: Double, scrollHeight: Double, contentHeight: Double,
                    widest: String? = nil, widestRight: Double? = nil, hasText: Bool = true, hasMedia: Bool = false,
                    errors: [String] = [], rejections: [String] = [], console: [String] = [], ccb: [String] = [], resources: [String] = []) {
            self.surface = surface
            self.size = size
            self.width = width
            self.height = height
            self.scrollWidth = scrollWidth
            self.scrollHeight = scrollHeight
            self.contentHeight = contentHeight
            self.widest = widest
            self.widestRight = widestRight
            self.hasText = hasText
            self.hasMedia = hasMedia
            self.errors = errors
            self.rejections = rejections
            self.console = console
            self.ccb = ccb
            self.resources = resources
        }

        /// WebKit hides an uncaught error's words in a sandboxed frame: the frame is drawn
        /// again on its own to read them.
        public var hasMaskedErrors: Bool {
            errors.contains { $0.hasPrefix("Script error.") }
        }
    }

    public struct Finding: Codable, Equatable, Sendable {
        public enum Level: String, Codable, Sendable { case problem, warning }
        public var level: Level
        /// "board 2x1", "chat".
        public var place: String
        public var text: String

        public init(level: Level, place: String, text: String) {
            self.level = level
            self.place = place
            self.text = text
        }
    }

    /// How many px past the frame still count as fitting (sub-pixel rounding).
    static let slack: Double = 1

    /// What is wrong with one drawn frame. `uniform`: its picture is (nearly) one colour.
    public static func judge(_ report: FrameReport, place: String, uniform: Bool) -> [Finding] {
        var findings: [Finding] = []
        let problem = { (text: String) in findings.append(Finding(level: .problem, place: place, text: text)) }
        // One line each: an error's stack lines follow it after " · ".
        let short = { (text: String) -> String in
            let line = text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: " · ")
            return line.count > 600 ? String(line.prefix(600)) + "…" : line
        }
        for error in report.errors { problem("Script error: \(short(error))") }
        for reason in report.rejections { problem("Unhandled promise rejection: \(short(reason))") }
        for line in report.console { problem("console.error: \(short(line))") }
        for line in report.ccb { problem(short(line)) }
        for resource in report.resources { problem("Did not load: \(short(resource)) (components cannot load outside resources; use data: URLs or ccb.image)") }
        if report.scrollWidth > report.width + slack {
            var text = "Wider than its frame: \(Int(report.scrollWidth))px of content in \(Int(report.width))px, cut off on the right"
            if let widest = report.widest, let right = report.widestRight { text += " (widest: \(widest), reaching \(Int(right))px)" }
            problem(text)
        }
        if report.contentHeight < 2 {
            problem("Draws nothing: its content is \(Int(report.contentHeight))px tall")
        } else if uniform, !report.hasText, !report.hasMedia {
            problem("Looks blank: one flat colour, no text or pictures")
        }
        if report.surface == "board", report.scrollHeight > report.height + slack {
            findings.append(Finding(level: .warning, place: place, text: "Taller than its tile: \(Int(report.scrollHeight))px of content in \(Int(report.height))px, the rest is cut off (collapse to a summary when short)"))
        }
        return findings
    }

    /// Whether a picture's pixels are (nearly) all one colour: `pixels` is RGBA, 8 bits each.
    public static func isUniform(_ pixels: [UInt8], tolerance: Int = 10, share: Double = 0.995) -> Bool {
        let count = pixels.count / 4
        guard count > 0 else { return true }
        // The most common colour, coarsely bucketed, against every pixel.
        var buckets: [Int: Int] = [:]
        for i in 0..<count {
            let key = (Int(pixels[i * 4]) >> 4) << 8 | (Int(pixels[i * 4 + 1]) >> 4) << 4 | (Int(pixels[i * 4 + 2]) >> 4)
            buckets[key, default: 0] += 1
        }
        guard let top = buckets.max(by: { $0.value < $1.value })?.key else { return true }
        let base = [((top >> 8) & 15) * 16 + 8, ((top >> 4) & 15) * 16 + 8, (top & 15) * 16 + 8]
        var near = 0
        for i in 0..<count where (0..<3).allSatisfy({ abs(Int(pixels[i * 4 + $0]) - base[$0]) <= tolerance + 8 }) {
            near += 1
        }
        return Double(near) / Double(count) >= share
    }

    // MARK: Reporting

    public struct Shot: Codable, Equatable, Sendable {
        public var place: String
        public var path: String

        public init(place: String, path: String) {
            self.place = place
            self.path = path
        }
    }

    /// What is printed: the verdict, each finding, and where the pictures are. The contact sheet
    /// is also written as a Markdown picture, ready to paste into a chat reply.
    public static func summary(component: String, data: DataSource, findings: [Finding], shots: [Shot], sheet: String?, notes: [String] = []) -> String {
        let problems = findings.filter { $0.level == .problem }
        let warnings = findings.filter { $0.level == .warning }
        var lines = ["Component \(component): \(shots.count) frame\(shots.count == 1 ? "" : "s") drawn (dark theme; data from \(data.description))."]
        lines += notes
        lines.append(problems.isEmpty ? "No problems." : "Problems (\(problems.count)):")
        lines += grouped(problems).map { "  ✗ \($0.places): \($0.text)" }
        if !warnings.isEmpty {
            lines.append("Warnings (\(warnings.count)):")
            lines += grouped(warnings).map { "  ! \($0.places): \($0.text)" }
        }
        if let sheet {
            lines.append("Contact sheet: \(sheet)")
            lines.append("  Markdown: ![\(component)](\(sheet))")
        }
        if !shots.isEmpty {
            lines.append("Pictures:")
            lines += shots.map { "  \($0.place): \($0.path)" }
        }
        return lines.joined(separator: "\n")
    }

    /// The same finding in several places once, with the places joined, in first-seen order.
    static func grouped(_ findings: [Finding]) -> [(places: String, text: String)] {
        var order: [String] = []
        var places: [String: [String]] = [:]
        for finding in findings {
            if places[finding.text] == nil { order.append(finding.text) }
            if !(places[finding.text]?.contains(finding.place) ?? false) { places[finding.text, default: []].append(finding.place) }
        }
        return order.map { (places[$0]!.joined(separator: ", "), $0) }
    }

    /// A file-safe name for a place: "board 2x1" → "board-2x1".
    public static func fileName(_ place: String) -> String {
        place.replacingOccurrences(of: " ", with: "-")
    }

    // MARK: The probe

    /// Set in a page that draws one frame's HTML on its own (to read errors a sandboxed frame hides).
    public static let replayFlagScript = "window.__ccbShotReplay = true;"

    /// Runs at the start of every frame. In a component frame it records errors, unhandled
    /// rejections, console.error, failed or unknown `ccb` calls and resources that did not load,
    /// then measures the frame once drawn and posts it all to `webkit.messageHandlers.ccbShot`
    /// (again whenever something new goes wrong).
    public static let probeScript = #"""
    (() => {
      if (window === window.top && !window.__ccbShotReplay) return;
      const report = {errors: [], rejections: [], console: [], ccb: [], resources: []};
      const text = (value) => {
        try {
          if (value instanceof Error) return value.name + ': ' + value.message + (value.stack ? '\n' + String(value.stack).split('\n').slice(0, 4).join('\n') : '');
          if (value && typeof value === 'object') return JSON.stringify(value);
          return String(value);
        } catch (error) { return String(value); }
      };
      const where = (element) => {
        let name = element.tagName.toLowerCase();
        if (element.id) name += '#' + element.id;
        const classes = [...element.classList].slice(0, 2);
        if (classes.length) name += '.' + classes.join('.');
        return name;
      };
      const measure = () => {
        const root = document.getElementById('ccb-root');
        if (!root) return null;
        const html = document.documentElement;
        const width = window.innerWidth, height = window.innerHeight;
        let widest = null, widestRight = 0, bottom = 0;
        for (const element of root.querySelectorAll('*')) {
          const box = element.getBoundingClientRect();
          if (!box.width && !box.height) continue;
          const style = getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          bottom = Math.max(bottom, box.bottom);
          if (box.right > width + 1 && box.right > widestRight) { widest = where(element); widestRight = box.right; }
        }
        const media = [...root.querySelectorAll('img,svg,canvas,video,picture,iframe')].some((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 4 && box.height > 4;
        });
        return {
          surface: html.dataset.surface || '', size: html.dataset.size || '',
          width, height,
          scrollWidth: Math.max(html.scrollWidth, document.body ? document.body.scrollWidth : 0),
          scrollHeight: Math.max(html.scrollHeight, document.body ? document.body.scrollHeight : 0),
          contentHeight: Math.max(root.getBoundingClientRect().height, bottom - root.getBoundingClientRect().top),
          widest, widestRight: widest ? widestRight : null,
          hasText: (root.innerText || '').trim().length > 0,
          hasMedia: media,
          ...report
        };
      };
      let sent = false;
      const send = () => {
        const measured = measure();
        if (!measured) return;
        sent = true;
        try { window.webkit.messageHandlers.ccbShot.postMessage(measured); } catch (error) {}
      };
      const again = () => { if (sent) setTimeout(send, 50); };
      window.addEventListener('error', (event) => {
        const target = event.target;
        if (target && target !== window && target.tagName) {
          report.resources.push(target.tagName.toLowerCase() + ' ' + (target.currentSrc || target.src || target.href || ''));
        } else {
          report.errors.push(event.error ? text(event.error) : (event.message || 'Error') + (event.lineno ? ' (line ' + event.lineno + ')' : ''));
        }
        again();
      }, true);
      window.addEventListener('unhandledrejection', (event) => { report.rejections.push(text(event.reason)); again(); });
      const original = console.error.bind(console);
      console.error = (...values) => { report.console.push(values.map(text).join(' ')); again(); original(...values); };
      // window.ccb: a call that throws or rejects, or a name ccb does not have, is reported.
      const quiet = new Set(['then', 'toJSON', 'constructor', 'valueOf', 'toString', 'nodeType', 'length', 'inspect']);
      const wrap = (api) => {
        if (!api || typeof api !== 'object') return api;
        return new Proxy(api, {
          get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver);
            if (typeof key !== 'string') return value;
            if (!(key in target)) {
              if (!quiet.has(key)) { report.ccb.push('ccb.' + key + ' is not part of ccb (see PLUGINS.md for the API)'); again(); }
              return value;
            }
            if (typeof value !== 'function') return value;
            return function (...values) {
              let result;
              try { result = value.apply(this === receiver ? target : this, values); }
              catch (error) { report.ccb.push('ccb.' + key + ' threw: ' + text(error)); again(); throw error; }
              if (result && typeof result.then === 'function') {
                result.then(null, (error) => { report.ccb.push('ccb.' + key + ' failed: ' + text(error)); again(); });
              }
              return result;
            };
          }
        });
      };
      let api;
      Object.defineProperty(window, 'ccb', {configurable: true, enumerable: true, get() { return api; }, set(value) { api = wrap(value); }});
      const settle = () => setTimeout(send, 1200);
      if (document.readyState === 'complete') settle();
      else window.addEventListener('load', settle);
    })();
    """#

    /// Read in the chat page: each component frame's place on the page, its HTML, surface and size.
    public static let framesScript = #"""
    (() => [...document.querySelectorAll('iframe')]
      .filter((frame) => (frame.srcdoc || '').includes('id="ccb-root"'))
      .map((frame) => {
        const box = frame.getBoundingClientRect();
        const head = frame.srcdoc.slice(0, 400);
        return {
          x: box.left, y: box.top, width: box.width, height: box.height,
          surface: (head.match(/data-surface="([^"]*)"/) || [])[1] || '',
          size: (head.match(/data-size="([^"]*)"/) || [])[1] || '',
          srcdoc: frame.srcdoc
        };
      })
      .filter((frame) => frame.width > 0 && frame.height > 0))()
    """#
}
