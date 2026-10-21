import AppKit

/// A run of the app that only draws a snapshot or checks a plugin, then quits. Agents start these
/// while you work, so such a run never shows a Dock icon, never takes focus and never puts a
/// window on screen: its windows are drawn offscreen.
public enum HeadlessRun {
    /// Every environment variable that asks for a snapshot (see Snapshot.swift).
    public static let environmentKeys = [
        "CCB_SNAPSHOT", "CCB_ICON", "CCB_CODEX_SNAPSHOT", "CCB_RAIL_SNAPSHOT", "CCB_RAIL_PINS_SNAPSHOT",
        "CCB_RIGHT_SNAPSHOT", "CCB_SETTINGS_SNAPSHOT", "CCB_RELEASES_SNAPSHOT", "CCB_SPEC_SNAPSHOT",
        "CCB_SHARE_SNAPSHOT",
    ]

    /// Every command-line flag that asks for a headless run.
    public static let flags = ["--snapshot", "--check-plugin"]

    public static func isRequested(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        arguments: [String] = CommandLine.arguments
    ) -> Bool {
        environmentKeys.contains { environment[$0] != nil } || flags.contains { arguments.contains($0) }
    }

    /// No Dock icon, no menu bar, never the active app.
    @MainActor
    public static func quiet(_ app: NSApplication) {
        app.setActivationPolicy(.prohibited)
    }

    /// A window to draw into that never reaches the screen: borderless, far off every display,
    /// see-through, deaf to the mouse, and never key or main.
    @MainActor
    public static func offscreenWindow(_ frame: NSRect) -> NSWindow {
        let window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        hide(window)
        return window
    }

    /// Makes a window that already exists (SwiftUI's own) as quiet as `offscreenWindow`.
    @MainActor
    public static func hide(_ window: NSWindow) {
        window.isReleasedWhenClosed = false
        window.ignoresMouseEvents = true
        window.isExcludedFromWindowsMenu = true
        window.hidesOnDeactivate = false
        window.level = .normal
        window.collectionBehavior = [.transient, .ignoresCycle, .stationary]
        window.animationBehavior = .none
        window.alphaValue = 0
        window.setFrameOrigin(offscreenOrigin)
        window.orderOut(nil)
    }

    /// Far left of and below every display.
    public static let offscreenOrigin = NSPoint(x: -30_000, y: -30_000)
}
