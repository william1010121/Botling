import AppKit
import ClaudeCodeBotCore
import WebKit

/// `ClaudeCodeBot --component-shot <component folder>` (see `ComponentShot`): draws the component
/// in this build's chat page, offscreen, once per surface, then pictures each frame, judges it,
/// writes a contact sheet and report.json, prints what is wrong and quits (0: no problems,
/// 1: problems, 2: bad usage, 3: it could not draw).
@MainActor
enum ComponentShotRun {
    static func runIfRequested() -> Bool {
        guard ComponentShot.isRequested() else { return false }
        switch ComponentShot.parse(CommandLine.arguments) {
        case let .failure(error):
            fail(error.description, code: 2)
        case let .success(options):
            Task { await run(options) }
        }
        return true
    }

    private static func fail(_ text: String, code: Int32) -> Never {
        FileHandle.standardError.write(Data((text + "\n").utf8))
        exit(code)
    }

    /// A surface drawn: its page's picture, each component frame on it, what each frame reported.
    private struct Drawn {
        var surface: ComponentShot.Surface
        var image: CGImage?
        var scale: CGFloat
        var frames: [Frame]
        var reports: [String: ComponentShot.FrameReport]
    }

    private struct Frame {
        var rect: CGRect
        var surface: String
        var size: String
        var srcdoc: String
        var key: String { "\(surface)|\(size)" }
    }

    /// How long each step is given, in seconds. The page says when it is ready, but not when a
    /// component's frames have finished drawing, so these are waits, named here with why.
    enum Timing {
        /// The whole run: an agent waiting on it must never hang.
        static let giveUp: TimeInterval = 180
        /// After the state is given, before the second script (open the sheet, float): the
        /// first drawing has started.
        static let beforeSecondScript: TimeInterval = 0.5
        /// After the page is ready, before the picture: frames load their templates and draw.
        static let settle: TimeInterval = 3.5
        /// A page that never says it is ready is pictured anyway after this long.
        static let pageNeverReady: TimeInterval = 20
        /// A replayed frame: after its first report (more may follow at once), and at the most.
        static let afterReport: TimeInterval = 0.5
        static let replayAtMost: TimeInterval = 5
    }

    private static func run(_ options: ComponentShot.Options) async {
        // Never hang an agent waiting on it.
        DispatchQueue.main.asyncAfter(deadline: .now() + Timing.giveUp) { fail("Gave up: drawing took over \(Int(Timing.giveUp / 60)) minutes.", code: 3) }
        guard let page = ChatSurface.pageURL else { fail("The chat page is not in this build.", code: 3) }
        let name = options.component.lastPathComponent
        let files = FileManager.default
        try? files.createDirectory(at: options.out, withIntermediateDirectories: true)

        // The data, and the Board sizes, from a throwaway copy of the library.
        let scratch = files.temporaryDirectory.appending(path: "ccb-shot-\(UUID().uuidString)")
        defer { try? files.removeItem(at: scratch) }
        let probe = prepare(scratch.appending(path: "probe"), component: options.component, name: name)
        var notes: [String] = []
        // Its Command runs once as written, as a chat card runs it, whatever the data is from:
        // a line the shell cannot run is a problem here, not a "The command failed" card later.
        let commandCheck = await ComponentShot.checkCommand(component: options.component, folder: options.folder)
        var findings: [ComponentShot.Finding] = commandCheck?.findings ?? []
        if let commandCheck, commandCheck.outcome.error == nil {
            notes.append("Its Command ran as written in \(commandCheck.folder.path).")
        }
        let source: ComponentShot.DataSource
        var data = "null"
        if let file = options.data {
            guard let text = try? String(contentsOf: file, encoding: .utf8) else { fail("Cannot read \(file.path).", code: 2) }
            guard ComponentShot.isJSON(text.trimmingCharacters(in: .whitespacesAndNewlines)) else { fail("\(file.path) is not JSON.", code: 2) }
            data = text.trimmingCharacters(in: .whitespacesAndNewlines)
            source = .file(file.path)
        } else if options.folder != nil, let commandCheck, let output = commandCheck.outcome.data {
            data = output
            source = .command(commandCheck.command)
        } else if let about = try? String(contentsOf: options.component.appending(path: "about.md"), encoding: .utf8),
                  let sample = ComponentShot.sampleData(fromAbout: about) {
            data = sample
            source = .example
            if commandCheck != nil, options.folder == nil {
                notes.append("It has a Command; pass --folder <project> to draw what the command prints.")
            }
        } else {
            source = .none
        }
        let sizes = ComponentShot.sizes(asked: options.sizes, hinted: probe.components.sizes(of: name))

        var drawn: [Drawn] = []
        for surface in options.surfaces {
            let root = scratch.appending(path: surface.rawValue)
            try? FileManager.default.createDirectory(at: Workspace.Layout.mainBot(in: root), withIntermediateDirectories: true)
            let store = BotStore(directory: Workspace.Layout.mainBot(in: root))
            switch surface {
            case .chat:
                var message = ChatMessage(role: .bot, text: "", date: Date())
                message.displays = [ComponentInstance(name: name, data: data)]
                store.save(messages: [message])
            case .board:
                store.save(pins: sizes.map { PinnedComponent(name: name, data: data, refresh: .manual, size: $0) })
            case .pinned:
                store.save(pins: [PinnedComponent(name: name, data: data, refresh: .manual, size: sizes.contains(.large) ? .large : sizes[0])])
            case .floating:
                var pin = PinnedComponent(name: name, data: data, refresh: .manual)
                pin.float = .init(corner: .topRight)
                store.save(pins: [pin])
            }
            let ready = prepare(root, component: options.component, name: name)
            let bot = ready.mainBot
            let json = ChatPayload.make(
                bot: bot, components: ready.components, pending: [], replyingTo: nil,
                pins: surface == .chat ? nil : ready.pinContext(for: bot, board: surface == .board),
                floating: surface == .floating ? ready.floatingPinViews(in: bot) : nil
            ) { projectID in
                AvatarImages.dataURL(projectID == nil ? .circle : .triangle, eyes: .open)
            }.json()
            let rows = sizes.map(\.rows).reduce(0, +)
            let frame: NSRect = switch surface {
            case .chat: NSRect(x: 0, y: 0, width: 760, height: 1100)
            case .board: NSRect(x: 0, y: 0, width: 900, height: min(4000, 300 + rows * 200))
            case .pinned: NSRect(x: 0, y: 0, width: 760, height: 1000)
            case .floating: NSRect(x: 0, y: 0, width: 1000, height: 800)
            }
            let open = surface == .pinned ? "document.dispatchEvent(new CustomEvent('ccb-open-pin', {detail: \(quoted(name))}))" : nil
            drawn.append(await draw(page: page, frame: frame, script: "\(ChatSurface.setPluginsScript(ready.plugins)); ccb.setState(\(json))", then: open, surface: surface))
        }

        // Judge each frame; a sandboxed frame hides an uncaught error's words, so such a frame is
        // drawn again on its own to read them.
        var shots: [ComponentShot.Shot] = []
        var tiles: [(String, CGImage)] = []
        for result in drawn {
            if let image = result.image {
                let path = options.out.appending(path: "page-\(result.surface.rawValue).png")
                write(image, to: path)
            }
            if result.frames.isEmpty, result.reports.isEmpty {
                // With no data a chat card says "Nothing to show" instead of drawing the component.
                let empty = data == "null" && result.surface == .chat
                findings.append(.init(level: empty ? .warning : .problem, place: result.surface.rawValue,
                                      text: empty ? "Not drawn: with null data the chat shows \"Nothing to show\" (give --data or add an example to about.md)" : "No component frame was drawn on this surface"))
                continue
            }
            var seen = Set<String>()
            for frame in result.frames where seen.insert(frame.key).inserted {
                let place = result.surface == .board ? "board \(frame.size)" : result.surface.rawValue
                guard var report = result.reports[frame.key] else {
                    findings.append(.init(level: .problem, place: place, text: "The frame never finished loading (its page did not reach load within a few seconds)"))
                    continue
                }
                if report.hasMaskedErrors, let replayed = await replay(frame) {
                    let words = replayed.errors.filter { !$0.hasPrefix("Script error.") }
                    if !words.isEmpty { report.errors = report.errors.filter { !$0.hasPrefix("Script error.") } + words }
                }
                var uniform = false
                if let image = result.image {
                    let exact = crop(image, frame.rect, scale: result.scale, pad: 0)
                    uniform = exact.map { ComponentShot.isUniform(pixels($0)) } ?? false
                    if let tile = crop(image, frame.rect, scale: result.scale, pad: 10) {
                        let path = options.out.appending(path: "\(ComponentShot.fileName(place)).png")
                        write(tile, to: path)
                        shots.append(.init(place: place, path: path.path))
                        tiles.append((place, tile))
                    }
                }
                findings += ComponentShot.judge(report, place: place, uniform: uniform)
            }
            // Reported but not on the page (scrolled away, hidden): judged without a picture.
            for (key, report) in result.reports where !seen.contains(key) {
                let place = result.surface == .board ? "board \(report.size)" : result.surface.rawValue
                findings += ComponentShot.judge(report, place: place, uniform: false)
            }
        }
        var sheet: String?
        if let image = contactSheet(tiles, title: name) {
            let path = options.out.appending(path: "contact-sheet.png")
            write(image, to: path)
            sheet = path.path
        }
        let report: [String: Any] = [
            "component": name,
            "data": source.description,
            "findings": findings.map { ["level": $0.level.rawValue, "place": $0.place, "text": $0.text] },
            "shots": shots.map { ["place": $0.place, "path": $0.path] },
            "contactSheet": sheet ?? NSNull(),
        ]
        if let json = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]) {
            try? json.write(to: options.out.appending(path: "report.json"))
        }
        print(ComponentShot.summary(component: name, data: source, findings: findings, shots: shots, sheet: sheet, notes: notes))
        print("Report: \(options.out.appending(path: "report.json").path)")
        exit(findings.contains { $0.level == .problem } ? 1 : 0)
    }

    /// A workspace under `root` whose library has a copy of the component.
    private static func prepare(_ root: URL, component: URL, name: String) -> Workspace {
        let library = Workspace.Layout.components(in: root)
        try? FileManager.default.createDirectory(at: library, withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: library.appending(path: name))
        try? FileManager.default.copyItem(at: component, to: library.appending(path: name))
        return Workspace(root: root, builtInPlugins: ChatSurface.builtInPlugins) { profile, store in
            Bot(profile: profile, launcher: { _ in throw AppError.claudeNotFound }, store: store)
        }
    }

    private static func quoted(_ text: String) -> String {
        (try? JSONSerialization.data(withJSONObject: text, options: [.fragmentsAllowed])).map { String(decoding: $0, as: UTF8.self) } ?? "\"\""
    }

    // MARK: Drawing

    private static var keep: [AnyObject] = []

    /// Loads the chat page in an offscreen window, gives it its state, waits for the frames to
    /// draw, then reads where they are and takes a picture.
    private static func draw(page: URL, frame: NSRect, script: String, then after: String?, surface: ComponentShot.Surface) async -> Drawn {
        await withCheckedContinuation { continuation in
            let window = HeadlessRun.offscreenWindow(frame)
            let configuration = WKWebViewConfiguration()
            let listener = Listener()
            configuration.userContentController.add(listener, name: "ccb")
            configuration.userContentController.add(listener, name: "ccbShot")
            configuration.userContentController.addUserScript(WKUserScript(source: ComponentShot.probeScript, injectionTime: .atDocumentStart, forMainFrameOnly: false))
            configuration.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
            configuration.setURLSchemeHandler(PreviewSchemeHandler.shared, forURLScheme: PagePreview.scheme)
            let view = WKWebView(frame: frame, configuration: configuration)
            window.contentView = view
            keep += [window, listener]
            var finished = false
            let finish = {
                guard !finished else { return }
                finished = true
                view.evaluateJavaScript(ComponentShot.framesScript) { value, _ in
                    let frames = (value as? [[String: Any]] ?? []).map { item in
                        Frame(rect: CGRect(x: number(item["x"]), y: number(item["y"]), width: number(item["width"]), height: number(item["height"])),
                              surface: item["surface"] as? String ?? "", size: item["size"] as? String ?? "", srcdoc: item["srcdoc"] as? String ?? "")
                    }
                    view.takeSnapshot(with: nil) { image, _ in
                        let cg = image?.cgImage(forProposedRect: nil, context: nil, hints: nil)
                        let scale = cg.map { CGFloat($0.width) / max(view.bounds.width, 1) } ?? 1
                        continuation.resume(returning: Drawn(surface: surface, image: cg, scale: scale, frames: frames, reports: listener.reports))
                        window.contentView = nil
                    }
                }
            }
            listener.onReady = {
                view.evaluateJavaScript(script)
                if let after {
                    DispatchQueue.main.asyncAfter(deadline: .now() + Timing.beforeSecondScript) { view.evaluateJavaScript(after) }
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + Timing.settle) { finish() }
            }
            // A page that never says it is ready is still pictured.
            DispatchQueue.main.asyncAfter(deadline: .now() + Timing.pageNeverReady) { finish() }
            view.loadFileURL(page, allowingReadAccessTo: URL(filePath: "/"))
        }
    }

    /// One frame's HTML on its own page with a real origin, where WebKit shows an uncaught error's
    /// words (in the sandboxed frame they are only "Script error.").
    private static func replay(_ frame: Frame) async -> ComponentShot.FrameReport? {
        await withCheckedContinuation { continuation in
            let rect = NSRect(x: 0, y: 0, width: max(frame.rect.width, 100), height: max(frame.rect.height, 100))
            let window = HeadlessRun.offscreenWindow(rect)
            let configuration = WKWebViewConfiguration()
            let listener = Listener()
            configuration.userContentController.add(listener, name: "ccbShot")
            configuration.userContentController.addUserScript(WKUserScript(source: ComponentShot.replayFlagScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            configuration.userContentController.addUserScript(WKUserScript(source: ComponentShot.probeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            let view = WKWebView(frame: rect, configuration: configuration)
            window.contentView = view
            keep += [window, listener]
            var finished = false
            let finish = {
                guard !finished else { return }
                finished = true
                continuation.resume(returning: listener.reports.values.first)
                window.contentView = nil
            }
            listener.onReport = { DispatchQueue.main.asyncAfter(deadline: .now() + Timing.afterReport) { finish() } }
            DispatchQueue.main.asyncAfter(deadline: .now() + Timing.replayAtMost) { finish() }
            view.loadHTMLString(frame.srcdoc, baseURL: URL(string: "https://component-shot.invalid/"))
        }
    }

    private final class Listener: NSObject, WKScriptMessageHandler {
        var onReady: (() -> Void)?
        var onReport: (() -> Void)?
        var reports: [String: ComponentShot.FrameReport] = [:]

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            if message.name == "ccb" {
                guard (message.body as? [String: Any])?["type"] as? String == "ready", let ready = onReady else { return }
                onReady = nil
                ready()
                return
            }
            guard let body = message.body as? [String: Any],
                  let data = try? JSONSerialization.data(withJSONObject: body),
                  let report = try? JSONDecoder().decode(ComponentShot.FrameReport.self, from: data) else { return }
            reports["\(report.surface)|\(report.size)"] = report
            onReport?()
        }
    }

    private static func number(_ value: Any?) -> CGFloat {
        CGFloat((value as? NSNumber)?.doubleValue ?? 0)
    }

    // MARK: Pictures

    /// The part of the page's picture under `rect` (page points), with `pad` points around it.
    private static func crop(_ image: CGImage, _ rect: CGRect, scale: CGFloat, pad: CGFloat) -> CGImage? {
        let area = CGRect(x: (rect.minX - pad) * scale, y: (rect.minY - pad) * scale,
                          width: (rect.width + pad * 2) * scale, height: (rect.height + pad * 2) * scale)
            .integral.intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard !area.isEmpty else { return nil }
        return image.cropping(to: area)
    }

    private static func pixels(_ image: CGImage) -> [UInt8] {
        let width = image.width, height = image.height
        var buffer = [UInt8](repeating: 0, count: width * height * 4)
        buffer.withUnsafeMutableBytes { bytes in
            guard let context = CGContext(data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        return buffer
    }

    private static func write(_ image: CGImage, to url: URL) {
        let rep = NSBitmapImageRep(cgImage: image)
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
    }

    /// Every frame's picture on one dark sheet, each labelled with where it was drawn.
    private static func contactSheet(_ tiles: [(String, CGImage)], title: String) -> CGImage? {
        guard !tiles.isEmpty else { return nil }
        let gap: CGFloat = 32, label: CGFloat = 44, maxWidth: CGFloat = 2400
        // Lay the tiles out in rows (pixel sizes, as captured).
        var placed: [(CGRect, String, CGImage)] = []
        var x = gap, y = gap + 64, rowHeight: CGFloat = 0, width: CGFloat = 0
        for (place, image) in tiles {
            let size = CGSize(width: image.width, height: image.height)
            if x > gap, x + size.width + gap > maxWidth {
                x = gap
                y += rowHeight + label + gap
                rowHeight = 0
            }
            placed.append((CGRect(x: x, y: y + label, width: size.width, height: size.height), place, image))
            x += size.width + gap
            width = max(width, x)
            rowHeight = max(rowHeight, size.height)
        }
        let height = y + rowHeight + label + gap
        guard let context = CGContext(data: nil, width: Int(width), height: Int(height), bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        // Top-left origin, like the page.
        context.translateBy(x: 0, y: height)
        context.scaleBy(x: 1, y: -1)
        context.setFillColor(CGColor(red: 0.07, green: 0.07, blue: 0.08, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let graphics = NSGraphicsContext(cgContext: context, flipped: true)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = graphics
        let titleStyle: [NSAttributedString.Key: Any] = [.font: NSFont.boldSystemFont(ofSize: 40), .foregroundColor: NSColor(white: 0.93, alpha: 1)]
        NSAttributedString(string: "\(title) · dark", attributes: titleStyle).draw(at: NSPoint(x: gap, y: gap))
        let labelStyle: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 28, weight: .medium), .foregroundColor: NSColor(white: 0.63, alpha: 1)]
        for (rect, place, image) in placed {
            NSAttributedString(string: place, attributes: labelStyle).draw(at: NSPoint(x: rect.minX, y: rect.minY - label + 4))
            context.saveGState()
            // Images draw upright in a flipped context only when flipped back locally.
            context.translateBy(x: rect.minX, y: rect.maxY)
            context.scaleBy(x: 1, y: -1)
            context.draw(image, in: CGRect(x: 0, y: 0, width: rect.width, height: rect.height))
            context.restoreGState()
            context.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.12))
            context.stroke(rect.insetBy(dx: -0.5, dy: -0.5))
        }
        NSGraphicsContext.restoreGraphicsState()
        return context.makeImage()
    }
}
