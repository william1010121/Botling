import Foundation

/// SwiftPM's generated lookup does not search a packaged macOS app's Contents/Resources.
enum CoreResources {
    static let bundle = resolve(resourcesURL: Bundle.main.resourceURL) { Bundle.module }

    /// Keep the SwiftPM fallback lazy: its generated initializer traps outside the build tree.
    static func resolve(resourcesURL: URL?, fallback: () -> Bundle) -> Bundle {
        // Accept the legacy name too when inspecting or repackaging an older app.
        for name in ["botling_ClaudeCodeBotCore.bundle", "ClaudeCodeBot_ClaudeCodeBotCore.bundle"] {
            if let url = resourcesURL?.appending(path: name), let bundle = Bundle(url: url) {
                return bundle
            }
        }
        return fallback()
    }
}
