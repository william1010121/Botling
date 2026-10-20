import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// The file window drawing a .md file as Markdown (with LaTeX) instead of raw text.
struct MarkdownFileTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-md-\(UUID().uuidString)").resolvingSymlinksInPath()

    func write(_ name: String, _ data: Data) throws -> URL {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let url = root.appending(path: name)
        try data.write(to: url)
        return url
    }

    @Test func knowsMarkdownFilesByExtension() {
        #expect(MarkdownFile.isMarkdown(URL(filePath: "/a/01-10-20 開會.md")))
        #expect(MarkdownFile.isMarkdown(URL(filePath: "/a/notes.MARKDOWN")))
        #expect(!MarkdownFile.isMarkdown(URL(filePath: "/a/notes.txt")))
        #expect(!MarkdownFile.isMarkdown(URL(filePath: "/a/data.csv")))
        #expect(!MarkdownFile.isMarkdown(URL(filePath: "/a/data.json")))
        #expect(!MarkdownFile.isMarkdown(URL(string: "https://example.com/readme.md")!))
    }

    @Test func readsUTF8WithOrWithoutBOM() {
        #expect(MarkdownFile.decode(Data("# 開會\n$x^2$".utf8)) == "# 開會\n$x^2$")
        #expect(MarkdownFile.decode(Data([0xEF, 0xBB, 0xBF]) + Data("# 標題".utf8)) == "# 標題")
    }

    @Test func readsBig5WhenItIsNotUTF8() throws {
        let big5 = String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.big5.rawValue)))
        let data = try #require("# 會議紀錄\n- 老師的想法".data(using: big5))
        #expect(String(data: data, encoding: .utf8) == nil)
        #expect(MarkdownFile.decode(data) == "# 會議紀錄\n- 老師的想法")
    }

    @Test func documentScriptCarriesTextBaseAndName() throws {
        let file = try write("報告 1.md", Data("# 標題\n\n![圖](pics/a.png) </script>".utf8))
        let script = try #require(MarkdownFile.documentScript(for: file))
        #expect(script.hasPrefix("window.ccbDocument = "))
        let json = String(script.dropFirst("window.ccbDocument = ".count)).trimmingCharacters(in: CharacterSet(charactersIn: ";\n"))
        let object = try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: String])
        #expect(object["text"] == "# 標題\n\n![圖](pics/a.png) </script>")
        #expect(object["name"] == "報告 1.md")
        // Relative pictures resolve against the file itself.
        #expect(URL(string: "pics/a.png", relativeTo: URL(string: object["base"]!))?.absoluteURL.path == root.appending(path: "pics/a.png").path)
    }

    @Test func noScriptForAMissingFile() {
        #expect(MarkdownFile.documentScript(for: root.appending(path: "nope.md")) == nil)
    }

    @Test func viewerPageIsBundledBesideTheChat() throws {
        // Built by Web/build.mjs into the app's resources, next to chat.html.
        let web = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "Sources/ClaudeCodeBot/Resources/web")
        let html = try String(contentsOf: web.appending(path: "viewer.html"), encoding: .utf8)
        #expect(html.contains("viewer.js"))
        #expect(html.contains("chat.css"))
        #expect(html.contains("katex.min.css"))
        // No inline scripts may run: the page's own code comes from its file only.
        #expect(html.contains("script-src 'self' file:;") || html.contains("script-src file:;"))
        #expect(FileManager.default.fileExists(atPath: web.appending(path: "viewer.js").path))
    }
}
