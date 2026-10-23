import AppKit
import ClaudeCodeBotCore
import WebKit

/// `botling --check-plugin <folder>` (`ccb plugin check`): checks a plugin before Botling uses it, and
/// exits 0 when it passes, 1 when it does not, printing what is wrong.
/// 1. package.json is valid, engines.ccb fits, the files it names exist.
/// 2. `npm run build` if it has a build script; 3. `npm test` if it has a test script.
/// 4. `claude plugin validate --strict` on its Claude part, if it has one.
/// 5. Its web part loads once in an invisible chat page without throwing.
@MainActor
enum PluginCheck {
    private static var folder: URL? {
        let arguments = CommandLine.arguments
        guard let index = arguments.firstIndex(of: "--check-plugin"), index + 1 < arguments.count else { return nil }
        return URL(filePath: arguments[index + 1]).standardizedFileURL
    }

    private static var window: NSWindow?
    private static var handler: Handler?

    /// Steps 1–4, before the app starts; quits if any fails. Step 5 needs the app running.
    static func exitIfRequested() {
        guard let folder else { return }
        print("Checking \(folder.path)")
        let problems = PluginRegistry.check(folder)
        guard problems.isEmpty, case let .success(manifest) = PluginRegistry.load(folder) else {
            fail(problems)
        }
        print("✓ package.json (\(manifest.name) \(manifest.version))")
        for script in ["build", "test"] where manifest.scripts?[script] != nil {
            guard run("/usr/bin/env", ["npm", "run", script], in: folder) else { fail(["npm run \(script) failed."]) }
            print("✓ npm run \(script)")
        }
        if let claude = manifest.ccb?.claude {
            guard let executable = ClaudeExecutableLocator().locate() else { fail(["claude not found, so the Claude part can't be checked."]) }
            let semaphore = DispatchSemaphore(value: 0)
            nonisolated(unsafe) var problem: String?
            Task.detached {
                problem = await ClaudePluginValidator.validate(folder.appending(path: claude), executable: executable)
                semaphore.signal()
            }
            semaphore.wait()
            if let problem { fail(["The Claude part failed claude plugin validate --strict: \(problem)"]) }
            print("✓ Claude part")
        }
        if manifest.ccb?.web == nil {
            print("Passed")
            exit(0)
        }
    }

    /// Step 5: loads the web part in an offscreen chat page and waits for it to finish.
    static func runIfRequested() -> Bool {
        guard let folder else { return false }
        guard let page = ChatSurface.pageURL else { fail(["Chat page not found."]) }
        // A throwaway library, so what plugins.json says (on, off, broken) does not matter here.
        let scratch = FileManager.default.temporaryDirectory.appending(path: "ccb-check-\(UUID().uuidString)/plugins")
        let registry = PluginRegistry(library: scratch, builtIns: folder.deletingLastPathComponent())
        guard let manifest = try? PluginRegistry.load(folder).get(),
              let spec = registry.webSpecs().first(where: { $0.name == manifest.name }),
              let data = try? JSONEncoder().encode([spec]) else {
            fail(["Couldn't read the web part."])
        }
        let configuration = WKWebViewConfiguration()
        let handler = Handler(specs: String(decoding: data, as: UTF8.self), name: manifest.name)
        configuration.userContentController.add(handler, name: "ccb")
        configuration.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        let frame = NSRect(x: 0, y: 0, width: 760, height: 600)
        let view = WKWebView(frame: frame, configuration: configuration)
        let window = HeadlessRun.offscreenWindow(frame)
        window.contentView = view
        handler.view = view
        view.loadFileURL(page, allowingReadAccessTo: URL(filePath: "/"))
        self.window = window
        self.handler = handler
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { fail(["The web part did not finish loading within 20 seconds."]) }
        return true
    }

    private final class Handler: NSObject, WKScriptMessageHandler {
        let specs: String
        let name: String
        weak var view: WKWebView?
        private var errors: [String] = []

        init(specs: String, name: String) {
            self.specs = specs
            self.name = name
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            switch type {
            case "ready":
                view?.callAsyncJavaScript(
                    "await ccb.setPlugins(JSON.parse(specs)); return true;",
                    arguments: ["specs": specs],
                    in: nil,
                    in: .page
                ) { [self] result in
                    MainActor.assumeIsolated {
                        if case let .failure(error) = result { errors.append(error.localizedDescription) }
                        if errors.isEmpty {
                            print("✓ Web part loaded")
                            print("Passed")
                            exit(0)
                        }
                        PluginCheck.fail(errors.map { "Web part error: \($0)" })
                    }
                }
            case "pluginError":
                errors.append(body["message"] as? String ?? "")
            default:
                break
            }
        }
    }

    private static func run(_ executable: String, _ arguments: [String], in folder: URL) -> Bool {
        let process = Process()
        process.executableURL = URL(filePath: executable)
        process.arguments = arguments
        process.currentDirectoryURL = folder
        do {
            try process.run()
        } catch {
            return false
        }
        process.waitUntilExit()
        return process.terminationStatus == 0
    }

    static func fail(_ problems: [String]) -> Never {
        print("Failed:")
        for problem in problems { print("- \(problem)") }
        exit(1)
    }
}
