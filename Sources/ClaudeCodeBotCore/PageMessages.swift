import Foundation

/// What the chat page may ask the app. Only the page itself is heard: a component draws in a
/// sandboxed frame and talks to the page (`parent.postMessage`), which answers for it, so a
/// frame posting to the app directly (say, to press "Allow and run" for the user) is ignored.
public enum PageMessages {
    public static func accepts(_ type: String, fromMainFrame: Bool) -> Bool {
        fromMainFrame
    }
}
