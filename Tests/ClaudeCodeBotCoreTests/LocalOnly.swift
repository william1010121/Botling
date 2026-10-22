import Foundation
import Testing

/// Tests CI skips (`CI` is set on GitHub's runners) and that still run locally by default. CI only
/// answers "does it build and do the fast, deterministic tests pass": these depend on the machine.
extension Trait where Self == ConditionTrait {
    /// For tests that depend on real time passing: timing checks, fixed sleeps, short real timers.
    /// Shared CI runners are too busy for that to mean anything.
    static var wallClock: Self {
        .disabled(if: onCI, "wall-clock timing is unreliable on shared CI runners")
    }

    /// For tests that run real programs (sh, git, node and the plugin host, the app) or need
    /// AppKit/WebKit: slow and at the mercy of the runner's tools and load.
    static var integration: Self {
        .disabled(if: onCI, "runs real processes or WebKit; local only")
    }
}

private let onCI = ProcessInfo.processInfo.environment["CI"] != nil
