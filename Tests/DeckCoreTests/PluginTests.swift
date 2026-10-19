import Foundation
import Testing
@testable import DeckCore

@MainActor
struct PluginTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "deck-plugins-\(UUID().uuidString)")

    /// Writes a plugin folder with a package.json built from `deck` and a web part.
    @discardableResult
    func plugin(
        _ name: String,
        in parent: URL? = nil,
        version: String = "1.0.0",
        engines: String = "^2.0.0",
        deck: String = #"{ "web": "dist/web.js", "contributes": { "settings": { "x.on": { "type": "boolean", "default": true, "title": "開" } } } }"#,
        web: String? = "export function activate() {}"
    ) throws -> URL {
        let folder = (parent ?? root.appending(path: "library")).appending(path: name)
        try FileManager.default.createDirectory(at: folder.appending(path: "dist"), withIntermediateDirectories: true)
        try """
        { "name": "\(name)", "version": "\(version)", "engines": { "deck": "\(engines)" }, "deck": \(deck) }
        """.write(to: folder.appending(path: "package.json"), atomically: true, encoding: .utf8)
        if let web { try web.write(to: folder.appending(path: "dist/web.js"), atomically: true, encoding: .utf8) }
        return folder
    }

    @Test func checkCatchesWhatIsWrong() throws {
        let good = try plugin("good")
        #expect(PluginRegistry.check(good).isEmpty)

        let missing = try plugin("missing", web: nil)
        #expect(PluginRegistry.check(missing).contains { $0.contains("dist/web.js") })

        let old = try plugin("old", engines: "^1.0.0")
        #expect(PluginRegistry.check(old).contains { $0.contains("不相容") })

        let badSetting = try plugin("bad-setting", deck: #"{ "contributes": { "settings": { "a": { "type": "enum", "options": ["x"], "default": "y", "title": "A" } } } }"#)
        #expect(PluginRegistry.check(badSetting).contains { $0.contains("options") })

        let escape = try plugin("escape", deck: #"{ "web": "../../etc/passwd" }"#)
        #expect(PluginRegistry.check(escape).contains { $0.contains("相對路徑") })

        let permission = try plugin("permission", deck: #"{ "permissions": ["root"] }"#)
        #expect(PluginRegistry.check(permission).contains { $0.contains("root") })

        let broken = root.appending(path: "library/broken")
        try FileManager.default.createDirectory(at: broken, withIntermediateDirectories: true)
        try "{ nope".write(to: broken.appending(path: "package.json"), atomically: true, encoding: .utf8)
        #expect(PluginRegistry.check(broken).first?.contains("格式不對") == true)
    }

    @Test func enginesRanges() {
        #expect(PluginRegistry.compatible("^2.0.0"))
        #expect(PluginRegistry.compatible("~2.0.1"))
        #expect(PluginRegistry.compatible(">=1.5.0"))
        #expect(PluginRegistry.compatible("*"))
        #expect(!PluginRegistry.compatible("^3.0.0"))
        #expect(!PluginRegistry.compatible("^2.4.0"))
    }

    @Test func libraryPluginsReplaceBuiltInsAndBrokenOnesAreListed() throws {
        let builtIns = root.appending(path: "builtin")
        try plugin("deck-latex", in: builtIns, version: "1.0.0")
        try plugin("deck-latex", version: "1.1.0")
        try plugin("helper")
        try plugin("bad", engines: "^9.0.0")
        let registry = PluginRegistry(library: root.appending(path: "library"), builtIns: builtIns)

        #expect(registry.plugins.map(\.name) == ["deck-latex", "helper"])
        #expect(registry.plugin("deck-latex")?.manifest.version == "1.1.0")
        #expect(registry.plugin("deck-latex")?.builtIn == false)
        #expect(registry.problems["bad"]?.isEmpty == false)
    }

    @Test func turningOffAndSettingsAreKept() throws {
        try plugin("helper")
        let library = root.appending(path: "library")
        let registry = PluginRegistry(library: library, builtIns: nil)
        #expect(registry.webSpecs().first?.settings["x.on"] == .bool(true))

        registry.set("helper", "x.on", to: .bool(false))
        #expect(registry.webSpecs().first?.settings["x.on"] == .bool(false))
        registry.setEnabled("helper", false)
        #expect(registry.webSpecs().isEmpty)

        let again = PluginRegistry(library: library, builtIns: nil)
        #expect(again.plugin("helper")?.enabled == false)
        again.setEnabled("helper", true)
        #expect(again.webSpecs().first?.settings["x.on"] == .bool(false))
        #expect(again.webSpecs().first?.source.contains("activate") == true)
    }

    @Test func aBrokenPluginIsOffUntilItsFilesChange() async throws {
        let folder = try plugin("helper")
        let registry = PluginRegistry(library: root.appending(path: "library"), builtIns: nil)
        var notices: [String] = []
        registry.onNotice = { notices.append($0) }

        registry.markFailed("helper", message: "boom")
        #expect(registry.plugin("helper")?.failure == "boom")
        #expect(registry.webSpecs().isEmpty)
        #expect(notices.count == 1)
        registry.markFailed("helper", message: "boom")
        #expect(notices.count == 1)

        // A fixed version gets another try.
        try await Task.sleep(for: .milliseconds(20))
        try "export function activate() { /* fixed */ }".write(to: folder.appending(path: "dist/web.js"), atomically: true, encoding: .utf8)
        let before = registry.revision
        registry.rescan()
        #expect(registry.revision > before)
        #expect(registry.plugin("helper")?.failure == nil)
        #expect(registry.webSpecs().first?.source.contains("fixed") == true)
    }

    @Test func componentsLiveInAPluginAndOldOnesMoveIn() throws {
        let deck = root.appending(path: "deck")
        let old = deck.appending(path: "components/meter")
        try FileManager.default.createDirectory(at: old, withIntermediateDirectories: true)
        try "<div>meter</div>".write(to: old.appending(path: "template.html"), atomically: true, encoding: .utf8)
        try "進度條".write(to: old.appending(path: "about.md"), atomically: true, encoding: .utf8)
        // Another plugin brings a component of its own.
        try plugin("charts", in: deck.appending(path: "plugins"), deck: #"{ "contributes": { "components": "components" } }"#, web: nil)
        let chart = deck.appending(path: "plugins/charts/components/bar")
        try FileManager.default.createDirectory(at: chart, withIntermediateDirectories: true)
        try "<div>bar</div>".write(to: chart.appending(path: "template.html"), atomically: true, encoding: .utf8)

        let workspace = Workspace(root: deck) { profile, store in
            Bot(profile: profile, launcher: FakeLauncher().launcher, store: store)
        }

        let folder = deck.appending(path: "plugins/deck-components/components")
        #expect(workspace.components.folder.standardizedFileURL == folder.standardizedFileURL)
        #expect(!FileManager.default.fileExists(atPath: deck.appending(path: "components").path))
        #expect(workspace.plugins.plugin("deck-components") != nil)
        #expect(workspace.components.names == ["bar", "choices", "meter"])
        #expect(workspace.components.template("bar") == "<div>bar</div>")
        #expect(workspace.components.catalog().contains("meter：進度條"))
    }
}
