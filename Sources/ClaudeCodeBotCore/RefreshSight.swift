import Foundation

/// What the user can see, for cards that refresh by themselves: they run again only while seen.
/// The window is shown (not minimized, not hidden, not fully covered: the app sets
/// `windowVisible` from the window's occlusion), and the page showing a chat said which of its
/// pins are on screen (`pinsVisible`: a chip above the input box, the opened pin, a Board tile
/// scrolled into view, a floating card). The page applies the same rule to its own timers
/// (Web/src/visible.ts): chat cards and floating pins refreshed every few seconds.
public struct RefreshSight: Equatable, Sendable {
    public var windowVisible = true
    /// The chat whose page told `pins`.
    public var chat: ObjectIdentifier?
    public var pins: Set<UUID> = []

    public init() {}

    /// Whether `pin` is seen, with `shown` the chat on screen.
    public func sees(_ pin: UUID, shown: ObjectIdentifier) -> Bool {
        windowVisible && chat == shown && pins.contains(pin)
    }

    /// Whether a window is shown: some of it is visible on screen (its occlusion state), it is
    /// not in the Dock, and the app is not hidden.
    public static func windowShows(occlusionVisible: Bool, miniaturized: Bool, appHidden: Bool) -> Bool {
        occlusionVisible && !miniaturized && !appHidden
    }
}
