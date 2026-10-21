import Foundation

/// `claude plugin validate --strict` on a plugin's Claude part, before any bot loads it.
public enum ClaudePluginValidator {
    /// nil when it passes; otherwise the problems it printed.
    public static func validate(_ folder: URL, executable: URL) async -> String? {
        await withCheckedContinuation { continuation in
            let process = Process()
            process.executableURL = executable
            process.arguments = ["plugin", "validate", "--strict", folder.path]
            var environment = ProcessInfo.processInfo.environment
            environment["CLAUDECODE"] = nil
            process.environment = environment
            let output = Pipe()
            process.standardOutput = output
            process.standardError = output
            process.terminationHandler = { ended in
                let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
                continuation.resume(returning: problem(status: ended.terminationStatus, output: text))
            }
            do {
                try process.run()
            } catch {
                continuation.resume(returning: "claude could not run: \(error.localizedDescription)")
            }
        }
    }

    /// Its exit status says whether it passed; what it printed is kept as it is (its lines
    /// joined, cut short), whatever words or symbols it uses.
    static func problem(status: Int32, output: String) -> String? {
        if status == 0 { return nil }
        let lines = output.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        let text = lines.joined(separator: "; ")
        guard !text.isEmpty else { return "Failed (\(status))" }
        return text.count > 1_000 ? String(text.prefix(1_000)) + "…" : text
    }
}
