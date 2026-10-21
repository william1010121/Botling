import Foundation
import Testing

/// The window's three columns (rail, chat, right panel) stay inside the window whatever a
/// column holds. A main bot with many things waiting on you once made the right panel taller
/// than the window: the row grew, was centred, and every column's top and the input box went
/// off the window's edges. Runs the built app (`swift build` first) in its window snapshot.
struct WindowLayoutTests {
    @Test(.enabled(if: FileManager.default.isExecutableFile(atPath: TestPaths.app.path)), arguments: [1, 14, 40])
    func columnsStayInsideTheWindow(waiting: Int) throws {
        let png = FileManager.default.temporaryDirectory.appending(path: "ccb-window-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: png) }
        let process = Process()
        process.executableURL = TestPaths.app
        var environment = ProcessInfo.processInfo.environment
        environment["CCB_WINDOW_SNAPSHOT"] = png.path
        environment["CCB_WINDOW_WAITING"] = "\(waiting)"
        process.environment = environment
        let output = Pipe()
        process.standardOutput = output
        try process.run()
        let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        process.waitUntilExit()
        #expect(text.contains("waiting: \(waiting),"), "\(text)")
        #expect(text.contains("columns fit"), "\(text)")
        #expect(process.terminationStatus == 0, "\(text)")
    }
}
