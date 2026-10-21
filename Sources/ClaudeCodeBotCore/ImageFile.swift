import Foundation

/// A picture the chat's lightbox may hand to Preview or Finder: a file on disk with a picture's
/// extension, so a page can never open an app or a script this way.
public enum ImageFile {
    public static let extensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tif", "tiff", "svg", "avif"]

    public static func isOpenable(_ url: URL, fileManager: FileManager = .default) -> Bool {
        guard url.isFileURL, extensions.contains(url.pathExtension.lowercased()) else { return false }
        var directory: ObjCBool = false
        return fileManager.fileExists(atPath: url.path, isDirectory: &directory) && !directory.boolValue
    }
}
