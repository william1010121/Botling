import CryptoKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// The pictures tool calls gave back, kept as files beside the chat (`step-images/` in the bot's
/// folder) so a step names a file instead of carrying megabytes of base64 in chat.json. Files are
/// named by their content, so the same picture read twice is one file; only the newest
/// `kept` are kept.
///
/// A big opaque picture (a screenshot) is kept as JPEG when that is clearly smaller, and a small
/// copy of each big picture goes in `thumbs/` beside it: the chat shows the small copy and opens
/// the full one when clicked, so opening a chat no longer reads every full-size screenshot.
public enum StepImages {
    static let folderName = "step-images"
    static let thumbsName = "thumbs"
    /// Pictures kept per bot; older ones go (their steps then fall back to the file a Read read).
    static let kept = 300
    /// The longest side of a small copy, in pixels: the chat shows a picture at most 320 points
    /// tall, so this is sharp on a Retina screen.
    static let thumbSide = 640
    /// Pictures smaller than this are kept as they are (nothing worth saving).
    static let compressAbove = 64 * 1024
    /// JPEG quality for kept pictures and their small copies.
    static let quality = 0.8
    /// Marks a folder whose older pictures were already made smaller (`compressExisting`).
    static let compressedMarker = ".compressed-1"

    static var temporaryFolder: URL {
        FileManager.default.temporaryDirectory.appending(path: "ClaudeCodeBot-\(folderName)")
    }

    static let extensions: [String: String] = [
        "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp",
        "image/svg+xml": "svg", "image/heic": "heic", "image/bmp": "bmp", "image/tiff": "tiff",
    ]

    /// Lossless formats a screenshot comes in, which JPEG can make much smaller.
    static let convertible: Set<String> = ["png", "bmp", "tiff"]

    /// Writes each picture into `folder` (once per content) and returns their paths.
    static func save(_ images: [ToolImage], in folder: URL) -> [String] {
        guard !images.isEmpty else { return [] }
        let manager = FileManager.default
        try? manager.createDirectory(at: folder, withIntermediateDirectories: true)
        let paths = images.compactMap { image -> String? in
            let hash = SHA256.hash(data: image.data).prefix(16).map { String(format: "%02x", $0) }.joined()
            let ext = extensions[image.mediaType.lowercased()] ?? "png"
            // Kept before, as it came or made smaller.
            for candidate in [ext, "jpg"] {
                let file = folder.appending(path: "\(hash).\(candidate)")
                if manager.fileExists(atPath: file.path) {
                    // Seen again: it counts as new, so pruning keeps it.
                    try? manager.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
                    return file.path
                }
            }
            let smaller = convertible.contains(ext) ? jpeg(from: image.data) : nil
            let file = folder.appending(path: "\(hash).\(smaller == nil ? ext : "jpg")")
            guard (try? (smaller ?? image.data).write(to: file, options: .atomic)) != nil else { return nil }
            writeThumb(of: smaller ?? image.data, for: file)
            return file.path
        }
        prune(folder, keeping: Set(paths))
        return paths
    }

    /// Leaves the newest `kept` pictures in `folder` (and always `keeping`), with their small copies.
    static func prune(_ folder: URL, keeping: Set<String>) {
        let manager = FileManager.default
        guard let files = try? manager.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey], options: .skipsHiddenFiles)
            .filter({ (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true }),
              files.count > kept else { return }
        let dated = files.map { file in
            (file, (try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast)
        }
        for (file, _) in dated.sorted(by: { $0.1 > $1.1 }).dropFirst(kept) where !keeping.contains(file.path) {
            try? manager.removeItem(at: file)
            for thumb in thumbCandidates(for: file) { try? manager.removeItem(at: thumb) }
        }
    }

    // MARK: Finding them

    /// The kept picture at `path`, or, when it was made smaller since the step named it, the JPEG
    /// that replaced it (same name, `.jpg`). Nil when neither is there.
    static func existing(_ path: String) -> String? {
        let manager = FileManager.default
        if manager.fileExists(atPath: path) { return path }
        let url = URL(filePath: path)
        guard convertible.contains(url.pathExtension.lowercased()) else { return nil }
        let replaced = url.deletingPathExtension().appendingPathExtension("jpg").path
        return manager.fileExists(atPath: replaced) ? replaced : nil
    }

    /// The small copy of the kept picture `file`, if it has one.
    static func thumb(for file: URL) -> URL? {
        thumbCandidates(for: file).first { FileManager.default.fileExists(atPath: $0.path) }
    }

    static func thumbCandidates(for file: URL) -> [URL] {
        let base = file.deletingLastPathComponent().appending(path: thumbsName).appending(path: file.deletingPathExtension().lastPathComponent)
        return [base.appendingPathExtension("jpg"), base.appendingPathExtension("png")]
    }

    // MARK: Making them smaller

    /// `data` as JPEG when it is a big picture with no see-through parts and JPEG is at least a
    /// tenth smaller; nil to keep it as it is.
    static func jpeg(from data: Data) -> Data? {
        guard data.count > compressAbove,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
              isOpaque(image),
              let encoded = encode(image, as: .jpeg),
              encoded.count < data.count * 9 / 10 else { return nil }
        return encoded
    }

    /// Writes the small copy of the picture `data` (kept as `file`) into `thumbs/`, if it is big
    /// enough to need one: JPEG, or PNG when it has see-through parts.
    @discardableResult
    static func writeThumb(of data: Data, for file: URL) -> URL? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              max(width, height) > thumbSide * 5 / 4 else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: thumbSide,
            kCGImageSourceCreateThumbnailWithTransform: true,
        ]
        guard let small = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let opaque = isOpaque(small)
        guard let encoded = encode(small, as: opaque ? .jpeg : .png), encoded.count < data.count else { return nil }
        let folder = file.deletingLastPathComponent().appending(path: thumbsName)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let thumb = folder.appending(path: file.deletingPathExtension().lastPathComponent).appendingPathExtension(opaque ? "jpg" : "png")
        return (try? encoded.write(to: thumb, options: .atomic)) != nil ? thumb : nil
    }

    static func encode(_ image: CGImage, as type: UTType) -> Data? {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, type.identifier as CFString, 1, nil) else { return nil }
        let options: [CFString: Any] = type == .jpeg ? [kCGImageDestinationLossyCompressionQuality: quality] : [:]
        CGImageDestinationAddImage(destination, image, options as CFDictionary)
        return CGImageDestinationFinalize(destination) ? output as Data : nil
    }

    /// Whether every pixel of `image` is fully opaque (screenshots often carry an alpha channel
    /// they do not use).
    static func isOpaque(_ image: CGImage) -> Bool {
        switch image.alphaInfo {
        case .none, .noneSkipFirst, .noneSkipLast: return true
        default: break
        }
        let width = image.width, height = image.height
        guard width > 0, height > 0 else { return false }
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return false }
        var index = 3
        while index < pixels.count {
            if pixels[index] != 255 { return false }
            index += 4
        }
        return true
    }

    // MARK: Pictures kept before

    /// What `compressExisting` did: bytes of pictures before and after, and how many it changed.
    public struct Compression: Equatable, Sendable {
        public var before = 0
        public var after = 0
        public var converted = 0
        public var thumbs = 0
        public var thumbBytes = 0
    }

    /// Once per folder: makes the pictures kept before this smaller the way `save` keeps new
    /// ones (big opaque PNGs become JPEG, the PNG removed once the JPEG is written; steps that
    /// name the PNG find the JPEG through `existing`) and gives big ones a small copy. Pictures
    /// it cannot read are left as they are. Nil when the folder was done before or has none.
    @discardableResult
    public static func compressExisting(in folder: URL) -> Compression? {
        let manager = FileManager.default
        let marker = folder.appending(path: compressedMarker)
        guard !manager.fileExists(atPath: marker.path),
              let files = try? manager.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.isRegularFileKey, .contentModificationDateKey], options: .skipsHiddenFiles) else { return nil }
        var result = Compression()
        for file in files where (try? file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
            guard let data = try? Data(contentsOf: file) else { continue }
            result.before += data.count
            var kept = file
            var keptData = data
            if convertible.contains(file.pathExtension.lowercased()), let smaller = jpeg(from: data) {
                let replacement = file.deletingPathExtension().appendingPathExtension("jpg")
                let date = (try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date()
                if (try? smaller.write(to: replacement, options: .atomic)) != nil {
                    // Keeps its place in pruning order.
                    try? manager.setAttributes([.modificationDate: date], ofItemAtPath: replacement.path)
                    try? manager.removeItem(at: file)
                    for old in thumbCandidates(for: file) { try? manager.removeItem(at: old) }
                    kept = replacement
                    keptData = smaller
                    result.converted += 1
                }
            }
            result.after += keptData.count
            if let thumb = thumb(for: kept) ?? writeThumb(of: keptData, for: kept) {
                result.thumbs += 1
                result.thumbBytes += (try? thumb.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            }
        }
        try? Data().write(to: marker)
        return result
    }
}
