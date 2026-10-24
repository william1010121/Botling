// swiftc -parse-as-library Tests/HandoffStripPreview/probe.swift -o /private/tmp/handoff-strip-probe
// /private/tmp/handoff-strip-probe <isolated-repo> <existing-output-directory>
import AppKit
import WebKit

@MainActor final class Probe: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    var loaded = false
    var actions = [[String: Any]]()
    let view: WKWebView
    let window: NSWindow
    let repo: URL
    let output: URL
    init(repo: URL, output: URL) {
        self.repo = repo; self.output = output
        let config = WKWebViewConfiguration(); config.websiteDataStore = .nonPersistent()
        // Match macOS Full Keyboard Access: include all native HTML buttons in Tab order.
        config.preferences.setValue(true, forKey: "tabFocusesLinks")
        view = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 620), configuration: config)
        window = NSWindow(contentRect: view.frame, styleMask: .borderless, backing: .buffered, defer: false)
        super.init()
        view.configuration.userContentController.add(self, name: "ccb")
        window.alphaValue = 0; window.isReleasedWhenClosed = false
        window.setFrameOrigin(NSPoint(x: -30000, y: -30000)); window.contentView = view
        view.navigationDelegate = self
    }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        if let action = m.body as? [String: Any] { actions.append(action) }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true }
    func js(_ source: String) async throws -> Any { try await view.evaluateJavaScript(source) as Any }
    func shot(_ name: String) async throws {
        let image = try await view.takeSnapshot(configuration: nil)
        try NSBitmapImageRep(data: image.tiffRepresentation!)!.representation(using: .png, properties: [:])!.write(to: output.appending(path: name + ".png"))
    }
    func key(_ code: UInt16, _ chars: String) async throws {
        window.makeFirstResponder(view)
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code)!
            if type == .keyDown { view.keyDown(with: event) } else { view.keyUp(with: event) }
        }
        try await Task.sleep(for: .milliseconds(80))
    }
    func run() async throws {
        view.loadFileURL(repo.appending(path: "Sources/ClaudeCodeBot/Resources/web/chat.html"), allowingReadAccessTo: repo)
        for _ in 0..<200 where !loaded { try await Task.sleep(for: .milliseconds(50)) }
        guard loaded else { throw NSError(domain: "Chat did not load", code: 1) }
        for file in ["Tests/PinDockPreview/fixture.js", "Tests/CompletionVerificationPreview/fixture.js", "Tests/HandoffStripPreview/fixture.js"] {
            _ = try await js(String(contentsOf: repo.appending(path: file), encoding: .utf8))
        }
        let assets = repo.appending(path: "Sources/ClaudeCodeBotCore/Resources/CharacterArt/animation-posters/avatars")
        var heads = [String: String]()
        for (mark, name) in [("C", "claude"), ("X", "gpt")] {
            heads[mark] = "data:image/png;base64," + (try Data(contentsOf: assets.appending(path: "\(name)/idle.png"))).base64EncodedString()
        }
        let headJSON = String(data: try JSONSerialization.data(withJSONObject: heads), encoding: .utf8)!
        _ = try await js("verificationFixture.seenHeads=\(headJSON); verificationFixture.messages.forEach((m,i)=>m.avatar=verificationFixture.seenHeads[i ? 'X' : 'C']); true")
        var results = [[String: Any]]()
        for width in [900, 654, 480, 360, 320] {
            view.setFrameSize(NSSize(width: width, height: 620)); window.setContentSize(view.frame.size)
            for count in [0, 1, 12] {
                for mode in ["none", "rounds", "task", "waiting", "many"] {
                    for working in [false, true] {
                        _ = try await js("ccb.setState(handoffStripFixture(\(count), '\(mode)', \(working))); true")
                        try await Task.sleep(for: .milliseconds(35))
                        var result = try await js("handoffStripMeasure()") as! [String: Any]
                        result["width"] = width; result["pins"] = count; result["mode"] = mode; result["working"] = working
                        results.append(result)
                        if !working && ((count == 12 && ["none", "task"].contains(mode)) || (count == 0 && mode == "task")) {
                            try await shot("strip-\(width)-\(count)-\(mode)")
                        }
                    }
                }
            }
        }
        try JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys]).write(to: output.appending(path: "layouts.json"))
        let failures = results.filter { $0["oneRow"] as? Bool != true || $0["controlsVisible"] as? Bool != true || $0["stopVisible"] as? Bool != true || $0["progressVisible"] as? Bool != true || $0["overflow"] as? Bool != false }
        guard failures.isEmpty else { throw NSError(domain: "\(failures.count)/\(results.count) layouts failed; see layouts.json", code: 2) }
        // No pin capability at all: the handoff chip remains at the start of the same status row.
        _ = try await js("const noPins = handoffStripFixture(0, 'task'); delete noPins.pins; ccb.setState(noPins); true")
        let noPins = try await js("handoffStripMeasure()") as! [String: Any]
        guard noPins["controlsVisible"] as? Bool == true, noPins["overflow"] as? Bool == false else { throw NSError(domain: "No pins failed", code: 3) }
        try await shot("strip-320-no-pin-capability")
        var checks = [String: Any]()
        _ = try await js("var empty = handoffStripFixture(0, 'none'); delete empty.pins; ccb.setState(empty); true")
        guard try await js("getComputedStyle(document.querySelector('.dock-row')).display") as? String == "none" else { throw NSError(domain: "Empty status row is not hidden", code: 13) }
        checks["emptyRowHidden"] = true
        // A focused Stop survives unrelated pin refresh; Enter and Space invoke exactly the existing action.
        for (mode, type) in [("task", "stopHandoff"), ("rounds", "stopRounds")] {
            for (code, chars) in [(UInt16(36), "\r"), (UInt16(49), " ")] {
                _ = try await js("ccb.setState(handoffStripFixture(12, '\(mode)')); document.querySelector('.handoff-stop').focus(); true")
                _ = try await js("var updated = handoffStripFixture(12, '\(mode)'); updated.pins[0].chip.text='Updated'; ccb.setState(updated); true")
                guard try await js("document.activeElement.matches('.handoff-stop')") as? Bool == true else { throw NSError(domain: "Stop focus lost", code: 4) }
                actions.removeAll(); try await key(code, chars)
                let stops = actions.filter { ($0["type"] as? String)?.hasPrefix("stop") == true }
                guard stops.count == 1, stops.first?["type"] as? String == type else { throw NSError(domain: "Keyboard activation failed: \(mode) \(code) \(actions)", code: 5) }
                if mode == "task" { guard stops.first?["handoffID"] as? String == "H0" else { throw NSError(domain: "Wrong handoff stopped", code: 6) } }
                let layout = try await js("({...handoffStripMeasure(),scrollX})") as! [String: Any]
                guard layout["controlsVisible"] as? Bool == true, layout["overflow"] as? Bool == false, layout["scrollX"] as? Int == 0 else { throw NSError(domain: "Post-activation overflow: \(layout)", code: 12) }
                checks["\(mode)-\(code)"] = stops
            }
        }
        _ = try await js("ccb.setState(handoffStripFixture(12, 'task')); document.querySelector('.handoff-toggle').focus(); true")
        try await key(48, "\t")
        guard try await js("document.activeElement.matches('.handoff-stop')") as? Bool == true else { throw NSError(domain: "Tab cannot reach Stop: \(try await js("document.activeElement.outerHTML"))", code: 7) }
        checks["tabToStop"] = true
        checks["focusedLayout"] = try await js("({...handoffStripMeasure(),scrollX,scrollY,viewport:visualViewport.width,offset:visualViewport.offsetLeft,html:document.documentElement.getBoundingClientRect().toJSON(),body:document.body.getBoundingClientRect().toJSON(),elements:[...document.querySelectorAll('.dock-row,.pin-dock,.pin-chip-list,.handoff-chip,.handoff-toggle,.handoff-stop')].map(el=>({class:el.className,rect:el.getBoundingClientRect().toJSON(),scrollWidth:el.scrollWidth,scrollLeft:el.scrollLeft,flex:getComputedStyle(el).flex,min:getComputedStyle(el).minWidth,max:getComputedStyle(el).maxWidth}))})")

        try JSONSerialization.data(withJSONObject: checks, options: [.prettyPrinted, .sortedKeys]).write(to: output.appending(path: "focused-layout.json"))
        let focusedLayout = checks["focusedLayout"] as! [String: Any]
        guard focusedLayout["controlsVisible"] as? Bool == true, focusedLayout["overflow"] as? Bool == false, focusedLayout["scrollX"] as? Int == 0 else { throw NSError(domain: "Focused controls clipped/overflowed: \(focusedLayout)", code: 11) }
        try await shot("strip-320-stop-focused")
        _ = try await js("document.querySelector('[data-id=P11]').focus(); true")
        let pin = try await js("pinDockFocusMeasure()") as! [String: Any]
        guard pin["visible"] as? Bool == true else { throw NSError(domain: "Focused pin clipped: \(pin)", code: 8) }
        checks["offscreenPinFocus"] = pin
        _ = try await js("document.activeElement.click(); true")
        guard try await js("document.activeElement.getAttribute('aria-expanded')") as? String == "true" else { throw NSError(domain: "Pin activation failed", code: 9) }
        _ = try await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); document.querySelector('.pin-chip.add').click(); true")
        guard try await js("document.querySelectorAll('.pin-picker-row').length") as? Int == 1 else { throw NSError(domain: "Add picker failed", code: 10) }
        checks["pinSheetAndPicker"] = true
        _ = try await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); ccb.setState(handoffStripFixture(12, 'many')); document.querySelector('.handoff-toggle').focus(); true")
        try await key(36, "\r")
        guard try await js("!document.querySelector('.handoff-panel').hidden") as? Bool == true else { throw NSError(domain: "Keyboard cannot open multiple handoffs", code: 14) }
        _ = try await js("document.querySelector('.handoff-stop-all').focus(); true")
        actions.removeAll(); try await key(49, " ")
        guard actions.filter({ $0["type"] as? String == "stopRounds" }).count == 1 else { throw NSError(domain: "Multiple-handoff Stop all inaccessible", code: 15) }
        checks["multipleHandoffKeyboardStopAll"] = true
        try JSONSerialization.data(withJSONObject: checks, options: [.prettyPrinted, .sortedKeys]).write(to: output.appending(path: "interaction.json"))
        print("PASS: \(results.count) production WKWebView layouts; no overflow/clipped controls; Enter/Space Stop actions, Tab, focus refresh, pin focus/sheet and add picker")
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
