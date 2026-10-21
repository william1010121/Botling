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
}
