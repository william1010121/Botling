// swiftc -parse-as-library Tests/PinDockPreview/probe.swift -o /private/tmp/pin-dock-probe
// /private/tmp/pin-dock-probe <isolated-repo> <existing-output-directory>
import AppKit
import WebKit

@MainActor final class Probe: NSObject, WKNavigationDelegate {
    var loaded = false
    let view: WKWebView
    let window: NSWindow
    let repo: URL
    let output: URL
    init(repo: URL, output: URL) {
        self.repo = repo; self.output = output
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        view = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 380), configuration: config)
        window = NSWindow(contentRect: view.frame, styleMask: .borderless, backing: .buffered, defer: false)
        super.init()
        window.alphaValue = 0; window.isReleasedWhenClosed = false
        window.setFrameOrigin(NSPoint(x: -30000, y: -30000)); window.contentView = view
        view.navigationDelegate = self
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true }
    func run() async throws {
        view.loadFileURL(repo.appending(path: "Sources/ClaudeCodeBot/Resources/web/chat.html"), allowingReadAccessTo: repo)
        for _ in 0..<200 where !loaded { try await Task.sleep(for: .milliseconds(50)) }
        guard loaded else { throw NSError(domain: "Chat did not load", code: 1) }
        let fixture = try String(contentsOf: repo.appending(path: "Tests/PinDockPreview/fixture.js"), encoding: .utf8)
        _ = try await view.evaluateJavaScript(fixture)
        var results = [[String: Any]]()
        for width in [900, 654, 640, 480, 360, 320] {
            view.setFrameSize(NSSize(width: width, height: 380)); window.setContentSize(view.frame.size)
            for (count, handoff) in [(1, false), (5, false), (12, false), (5, true)] {
                _ = try await view.evaluateJavaScript("ccb.setState(pinDockFixture(\(count), \(handoff))); true")
                try await Task.sleep(for: .milliseconds(100))
                var result = try await view.evaluateJavaScript("pinDockMeasure()") as! [String: Any]
                result["width"] = width; result["pins"] = count; result["handoff"] = handoff
                results.append(result)
                if count == 5 {
                    let shot = try await view.takeSnapshot(configuration: nil)
                    let png = NSBitmapImageRep(data: shot.tiffRepresentation!)!.representation(using: .png, properties: [:])!
                    try png.write(to: output.appending(path: "strip-\(width)\(handoff ? "-handoff" : "").png"))
                }
            }
        }
        try JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys]).write(to: output.appending(path: "webkit-results.json"))
        let failures = results.filter { $0["oneRow"] as? Bool != true || $0["addVisible"] as? Bool != true || $0["overflow"] as? Bool != false }
        guard failures.isEmpty else { throw NSError(domain: "\(failures.count)/\(results.count) layouts failed: \(failures)", code: 2) }
        _ = try await view.evaluateJavaScript("ccb.setState(pinDockFixture(12)); document.querySelector('[data-id=\"P11\"]').focus(); true")
        var focusResults = [[String: Any]]()
        for action in [
            "true",
            "const refreshed = pinDockFixture(12); refreshed.pins[11].chip.text = 'Updated status'; ccb.setState(refreshed); true",
            "document.activeElement.click(); true",
            "document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'})); true"
        ] {
            _ = try await view.evaluateJavaScript(action)
            let result = try await view.evaluateJavaScript("pinDockFocusMeasure()") as! [String: Any]
            guard result["id"] as? String == "P11", result["visible"] as? Bool == true, (result["scrollLeft"] as? Double ?? 0) > 0 else {
                throw NSError(domain: "Focused pin not revealed/retained: \(result)", code: 3)
            }
            focusResults.append(result)
        }
        guard focusResults[2]["expanded"] as? String == "true", focusResults[3]["expanded"] as? String == "false" else {
            throw NSError(domain: "Sheet activation failed", code: 4)
        }
        try JSONSerialization.data(withJSONObject: focusResults, options: [.prettyPrinted, .sortedKeys]).write(to: output.appending(path: "webkit-focus-results.json"))
        let focused = try await view.takeSnapshot(configuration: nil)
        try NSBitmapImageRep(data: focused.tiffRepresentation!)!.representation(using: .png, properties: [:])!.write(to: output.appending(path: "strip-320-focused.png"))
        _ = try await view.evaluateJavaScript("document.querySelector('.pin-chip.add').focus(); const updated = pinDockFixture(12); updated.pins[0].chip.text = 'Refreshed'; ccb.setState(updated); true")
        let addFocused = try await view.evaluateJavaScript("document.activeElement.matches('.pin-chip.add')") as? Bool
        guard addFocused == true else { throw NSError(domain: "Add focus lost on refresh", code: 5) }
        _ = try await view.evaluateJavaScript("document.activeElement.click(); true")
        guard try await view.evaluateJavaScript("document.querySelectorAll('.pin-picker-row').length") as? Int == 1 else { throw NSError(domain: "Add picker failed", code: 6) }
        let picker = try await view.takeSnapshot(configuration: nil)
        try NSBitmapImageRep(data: picker.tiffRepresentation!)!.representation(using: .png, properties: [:])!.write(to: output.appending(path: "strip-320-picker.png"))
        print("PASS: 24 WKWebView layouts; 900/654/640/480/360/320px; 1/5/12 pins and handoff; single row, visible add, no document overflow; offscreen focus, live refresh, sheet open/close, add focus/picker; 14 screenshots")
    }
}
@main struct Main {
    @MainActor static func main() {
        let app = NSApplication.shared; app.setActivationPolicy(.prohibited)
        let probe = Probe(repo: URL(filePath: CommandLine.arguments[1]), output: URL(filePath: CommandLine.arguments[2]))
        Task { @MainActor in do { try await probe.run(); exit(0) } catch { print("FAIL", error); exit(1) } }
        app.run()
    }
}
