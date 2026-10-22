import Foundation

/// SwiftPM's generated lookup does not search a packaged macOS app's Contents/Resources.
enum CoreResources {
    static let bundle = resolve(resourcesURL: Bundle.main.resourceURL) { Bundle.module }

    /// Keep the SwiftPM fallback lazy: its generated initializer traps outside the build tree.
    static func resolve(resourcesURL: URL?, fallback: () -> Bundle) -> Bundle {
        if let url = resourcesURL?.appending(path: "ClaudeCodeBot_ClaudeCodeBotCore.bundle"),
           let bundle = Bundle(url: url) {
            return bundle
        }
        return fallback()
    }
}
