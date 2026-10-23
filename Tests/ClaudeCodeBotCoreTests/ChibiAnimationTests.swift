import Foundation
import ImageIO
import Testing
@testable import ClaudeCodeBotCore

@MainActor
struct ChibiAnimationTests {
    @Test func allTwelveSourcesDecodeMultipleDistinctFrames() throws {
        let clips = ChibiAnimation.clips
        #expect(clips.count == 12)
        #expect(Set(clips.map(\.id)).count == 12)
        for engine in ["claude", "codex"] {
            for kind in ["avatar", "sticker"] {
                #expect(Set(clips.filter { $0.engine == engine && $0.kind == kind }.map(\.action)) == ["blink", "typing", "wave"])
            }
        }
        for clip in clips {
            let url = try #require(URL(string: clip.file))
            #expect(url.isFileURL)
            #expect(url.pathExtension == "gif")
            let source = try #require(CGImageSourceCreateWithURL(url as CFURL, nil))
            #expect(CGImageSourceGetCount(source) == 4)
            var pixels = Set<Data>()
            var duration = 0.0
            for index in 0..<CGImageSourceGetCount(source) {
                let image = try #require(CGImageSourceCreateImageAtIndex(source, index, nil))
                #expect(image.width == 512 && image.height == 512)
                pixels.insert(try #require(image.dataProvider?.data) as Data)
                let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any])
                let gif = try #require(properties[kCGImagePropertyGIFDictionary] as? [CFString: Any])
                duration += try #require(gif[kCGImagePropertyGIFUnclampedDelayTime] as? Double ?? gif[kCGImagePropertyGIFDelayTime] as? Double)
            }
            #expect(pixels.count > 1)
            #expect(abs(duration * 1000 - Double(clip.duration)) < 1)
            let poster = try #require(URL(string: clip.poster))
            #expect(CGImageSourceCreateWithURL(poster as CFURL, nil) != nil)
        }
    }

    @Test func originalAndGroupPayloadsDoNotReceiveAnimations() throws {
        let bot = makeBot(FakeLauncher())
        let head = ChibiAnimation.Head(engine: "claude", avatar: "portrait", thinking: "thinking", sleeping: "sleeping", hat: "hat", clips: ChibiAnimation.clips)
        let look = ChatPayload.HeadLook(avatar: { _ in "portrait" }, mark: { _ in "mark" }, animations: [head])
        let cute = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil, look: look) { _ in "custom" }
        #expect(cute.animatedHeads?.first?.clips.count == 12)
        #expect(cute.avatarMood == "sleep")
        let original = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil) { _ in "custom" }
        #expect(original.animatedHeads == nil)
        #expect(original.avatarMood == nil)
        let group = ChatPayload.make(bot: bot, components: nil, pending: [], replyingTo: nil, group: .init(typing: nil, speaker: { _ in nil }), look: look) { _ in "custom" }
        #expect(group.animatedHeads == nil)
        let json = try #require(JSONSerialization.jsonObject(with: Data(cute.json().utf8)) as? [String: Any])
        #expect((json["animatedHeads"] as? [[String: Any]])?.count == 1)
    }
}
