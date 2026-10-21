import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// The chat page reads Swift's limits and tables from `Web/src/contract.json`; this keeps the
/// file what Swift says (set `CCB_WRITE_WEB_CONTRACT=1` to write it after changing a limit).
struct WebContractTests {
    static let file = TestPaths.repo.appending(path: "Web/src/contract.json")

    @Test func theWebContractFileIsUpToDate() throws {
        if ProcessInfo.processInfo.environment["CCB_WRITE_WEB_CONTRACT"] == "1" {
            try Data(WebContract.json.utf8).write(to: Self.file)
        }
        let written = try String(contentsOf: Self.file, encoding: .utf8)
        #expect(written == WebContract.json, "Web/src/contract.json is out of date: run CCB_WRITE_WEB_CONTRACT=1 swift test --filter WebContractTests")
    }

    @Test func everyBoardSizeHasItsName() {
        let names = WebContract.contract.board.sizeNames
        #expect(names.count == PinnedComponent.Size.all.count)
        #expect(names["1x1"] == "small" && names["4x2"] == "xlarge" && names["4x4"] == "xlarge")
    }

    /// The same cases Web/test reads for the input box's / suggestions.
    @Test func componentMentionsReadTheSharedCases() throws {
        struct Case: Decodable { var text: String; var name: String; var found: Bool }
        let data = try Data(contentsOf: TestPaths.repo.appending(path: "Web/test/fixtures/component-mentions.json"))
        for item in try JSONDecoder().decode([Case].self, from: data) {
            #expect(ComponentMentions.names(in: item.text, among: [item.name]).contains(item.name) == item.found, "\(item.text)")
        }
    }

    /// Maintainer is told to bundle with the esbuild the app's own plugins are built with.
    @Test @MainActor func maintainersBundlerIsTheRepositorysOwn() throws {
        let data = try Data(contentsOf: TestPaths.repo.appending(path: "Web/package.json"))
        let package = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let dev = try #require(package["devDependencies"] as? [String: String])
        #expect(dev["esbuild"] == Workspace.bundlerVersion)
    }
}

struct SharedRulesTests {
    @Test func taskEndWordsAreReadOnce() {
        #expect(TaskEnd("completed") == .completed && TaskEnd("DONE") == .completed)
        #expect(TaskEnd("error") == .failed)
        #expect(TaskEnd("cancelled") == .killed)
        #expect(TaskEnd("running") == nil && TaskEnd(nil) == nil && TaskEnd("pending") == nil)
        #expect(BackgroundTask.Status(notification: "done") == .completed)
        #expect(BackgroundTask.Status(notification: "something new") == .killed)
    }

    @Test func everyPermissionHasWordsForTheInstallQuestion() {
        for permission in PluginPermission.allCases {
            #expect(!PluginInstaller.describe(permission: permission.rawValue).hasPrefix("\""))
        }
    }

    @Test func builtInManifestsAskForThisBuildsAPI() throws {
        let text = PluginManifest.builtIn(name: "x", displayName: "X", description: "d", permissions: [.claude], claude: "claude").fileText
        let manifest = try JSONDecoder().decode(PluginManifest.self, from: Data(text.utf8))
        #expect(manifest.engines?["ccb"] == PluginManifest.engineRange)
        #expect(PluginRegistry.compatible(PluginManifest.engineRange))
        #expect(manifest.ccb?.permissions == ["claude"])
    }

    @Test func theProbeFollowsAGateway() {
        let config = FileManager.default.temporaryDirectory.appending(path: "ccb-probe-\(UUID().uuidString)")
        #expect(NetworkProbe.endpoint(environment: [:], config: config) == NetworkProbe.defaultEndpoint)
        #expect(NetworkProbe.endpoint(environment: ["ANTHROPIC_BASE_URL": "https://gateway.example/v1"], config: config).host == "gateway.example")
        #expect(NetworkProbe.endpoint(environment: ["ANTHROPIC_BASE_URL": "not a url"], config: config) == NetworkProbe.defaultEndpoint)
    }

    @Test func toolSearchFoldersAreOneList() {
        let home = URL(filePath: "/Users/someone")
        let locator = ClaudeExecutableLocator(command: "gh")
        #expect(ClaudeExecutableLocator.searchFolders(home: home).contains("/Users/someone/.local/bin"))
        #expect(locator.candidatePaths.allSatisfy { $0.hasSuffix("/gh") })
    }
}
