import Foundation

/// The supplied pack's twelve animations. Resource URLs resolve in SwiftPM and a relocated app;
/// the chat already loads local pictures with file read access. No base64 animation per message.
public enum ChibiAnimation {
    public struct Clip: Codable, Equatable, Sendable {
        public var id: String
        public var engine: String
        public var kind: String
        public var action: String
        public var file: String
        public var poster: String
        public var duration: Int
    }

    public struct Head: Encodable, Equatable {
        public var engine: String
        /// Matches the existing static avatar, so custom/group/Original avatars stay untouched.
        public var avatar: String
        public var thinking: String
        public var sleeping: String
        public var hat: String
        public var clips: [Clip]

        public init(engine: String, avatar: String, thinking: String, sleeping: String, hat: String, clips: [Clip]) {
            self.engine = engine
            self.avatar = avatar
            self.thinking = thinking
            self.sleeping = sleeping
            self.hat = hat
            self.clips = clips
        }
    }

    /// Fail soft: a missing catalog or clip keeps the established static avatars working.
    public static let clips: [Clip] = {
        guard let root = CoreResources.bundle.url(forResource: "CharacterArt", withExtension: nil),
              let data = try? Data(contentsOf: root.appending(path: "animations.json")),
              let catalog = try? JSONDecoder().decode([Clip].self, from: data) else { return [] }
        return catalog.compactMap { clip in
            let file = root.appending(path: clip.file)
            let poster = root.appending(path: clip.poster)
            guard FileManager.default.fileExists(atPath: file.path),
                  FileManager.default.fileExists(atPath: poster.path) else { return nil }
            var resolved = clip
            resolved.file = file.absoluteString
            resolved.poster = poster.absoluteString
            return resolved
        }
    }()
}
