import Foundation

/// Splits a byte stream into newline-terminated lines, holding back a partial last line.
/// Copied from NotchDo.
final class LineBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var pending = Data()

    func append(_ data: Data) -> [String] {
        lock.withLock {
            pending.append(data)
            var lines: [String] = []
            while let newline = pending.firstIndex(of: 0x0A) {
                let lineData = pending[pending.startIndex..<newline]
                pending.removeSubrange(pending.startIndex...newline)
                if !lineData.isEmpty {
                    lines.append(String(decoding: lineData, as: UTF8.self))
                }
            }
            return lines
        }
    }

    /// The unterminated remainder at end of stream, if any.
    func flush() -> String? {
        lock.withLock {
            defer { pending.removeAll() }
            return pending.isEmpty ? nil : String(decoding: pending, as: UTF8.self)
        }
    }
}
