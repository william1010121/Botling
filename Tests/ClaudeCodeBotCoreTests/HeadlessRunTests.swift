import AppKit
import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// Snapshot and plugin-check runs (started by agents while you work) stay out of your way: no
/// Dock icon, no focus, no window on screen.
@MainActor
struct HeadlessRunTests {
    @Test func everySnapshotVariableMakesAHeadlessRun() throws {
        // Each `environment["CCB_…_SNAPSHOT"]` that Snapshot.swift answers to is known here, so a
        // new kind of snapshot can't open the real app window again.
        let source = try String(contentsOf: URL(filePath: #filePath)
            .deletingLastPathComponent().appending(path: "../../Sources/ClaudeCodeBot/Snapshot.swift").standardizedFileURL, encoding: .utf8)
        let pattern = try Regex(#"environment\["(CCB_[A-Z_]*SNAPSHOT|CCB_ICON)"\]"#)
        let used = Set(source.matches(of: pattern).compactMap { $0.output[1].substring.map(String.init) })
        #expect(used.count >= 10)
        for key in used {
            #expect(HeadlessRun.environmentKeys.contains(key), "\(key)")
            #expect(HeadlessRun.isRequested(environment: [key: "/tmp/x.png"], arguments: ["ClaudeCodeBot"]))
        }
    }

    @Test func flagsMakeAHeadlessRunAndTheAppIsNormalOtherwise() {
        #expect(HeadlessRun.isRequested(environment: [:], arguments: ["ClaudeCodeBot", "--snapshot", "Main bot", "/tmp/x.png"]))
        #expect(HeadlessRun.isRequested(environment: [:], arguments: ["ClaudeCodeBot", "--check-plugin", "/tmp/p"]))
        #expect(!HeadlessRun.isRequested(environment: ["CCB_SNAPSHOT_JS": "x", "HOME": "/"], arguments: ["ClaudeCodeBot"]))
    }

    @Test func aHeadlessWindowNeverReachesTheScreen() {
        let window = HeadlessRun.offscreenWindow(NSRect(x: 0, y: 0, width: 760, height: 1300))
        #expect(!window.isVisible)
        #expect(!window.canBecomeKey)
        #expect(window.ignoresMouseEvents)
        #expect(window.alphaValue == 0)
        #expect(window.level == .normal)
        #expect(window.contentLayoutRect.size == NSSize(width: 760, height: 1300))
        for screen in NSScreen.screens {
            #expect(!screen.frame.intersects(window.frame))
        }
    }

    @Test func quietMeansNoDockIconAndNoFocus() {
        HeadlessRun.quiet(NSApplication.shared)
        #expect(NSApplication.shared.activationPolicy() == .prohibited)
        #expect(!NSApplication.shared.isActive)
    }
}
