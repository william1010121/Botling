import CryptoKit
import Foundation

/// The pictures tool calls gave back, kept as files beside the chat (`step-images/` in the bot's
/// folder) so a step names a file instead of carrying megabytes of base64 in chat.json. Files are
/// named by their content, so the same picture read twice is one file; only the newest
/// `kept` are kept.
public enum StepImages {
    static let folderName = "step-images"
    /// Pictures kept per bot; older ones go (their steps then fall back to the file a Read read).
    static let kept = 300

    static var temporaryFolder: URL {
        FileManager.default.temporaryDirectory.appending(path: "ClaudeCodeBot-\(folderName)")
    }

    static let extensions: [String: String] = [
        "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp",
        "image/svg+xml": "svg", "image/heic": "heic", "image/bmp": "bmp", "image/tiff": "tiff",
    ]

    /// Writes each picture into `folder` (once per content) and returns their paths.
    static func save(_ images: [ToolImage], in folder: URL) -> [String] {
        guard !images.isEmpty else { return [] }
        let manager = FileManager.default
        try? manager.createDirectory(at: folder, withIntermediateDirectories: true)
        let paths = images.compactMap { image -> String? in
            let hash = SHA256.hash(data: image.data).prefix(16).map { String(format: "%02x", $0) }.joined()
            let file = folder.appending(path: "\(hash).\(extensions[image.mediaType.lowercased()] ?? "png")")
            if manager.fileExists(atPath: file.path) {
                // Seen again: it counts as new, so pruning keeps it.
                try? manager.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
            } else {
                guard (try? image.data.write(to: file, options: .atomic)) != nil else { return nil }
            }
            return file.path
        }
        prune(folder, keeping: Set(paths))
        return paths
    }

    /// Leaves the newest `kept` pictures in `folder` (and always `keeping`).
    static func prune(_ folder: URL, keeping: Set<String>) {
        let manager = FileManager.default
        guard let files = try? manager.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey]),
              files.count > kept else { return }
        let dated = files.map { file in
            (file, (try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast)
        }
        for (file, _) in dated.sorted(by: { $0.1 > $1.1 }).dropFirst(kept) where !keeping.contains(file.path) {
            try? manager.removeItem(at: file)
        }
    }
}
