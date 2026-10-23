import Combine
import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor
struct ChatAvatarSizeTests {
    @Test func oldSettingsKeepResponsiveDefaultAndCustomSizeRoundTrips() throws {
        var settings = try JSONDecoder().decode(AppSettings.self, from: Data("{\"developerMode\":false}".utf8))
        #expect(settings.chatAvatarSizeChoice == nil)
        #expect(settings.chatAvatarSize == 48)
        #expect(SettingsSection.matching("Chat avatar size", in: SettingsSection.allCases) == [.general])
        settings.chatAvatarSizeChoice = 80
        let restored = try JSONDecoder().decode(AppSettings.self, from: JSONEncoder().encode(settings))
        #expect(restored.chatAvatarSizeChoice == 80)
        #expect(restored.chatAvatarSize == 80)
        settings.chatAvatarSizeChoice = Int.max
        #expect(settings.chatAvatarSize == 96)
        settings.chatAvatarSizeChoice = Int.min
        #expect(settings.chatAvatarSize == 32)
    }

    @Test func savesPublishesAndReloadsWithoutChangingOtherSettings() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-avatar-size-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        func open() -> Workspace {
            Workspace(root: root) { profile, store in Bot(profile: profile, launcher: FakeLauncher().launcher, store: store) }
        }
        let workspace = open()
        workspace.setBotLook(.original)
        var published: [Int?] = []
        let subscription = workspace.$settings.sink { published.append($0.chatAvatarSizeChoice) }
        workspace.setChatAvatarSize(80)
        #expect(published.last! == 80)
        #expect(AppSettings.load(from: workspace.settingsURL).chatAvatarSize == 80)
        #expect(open().settings.chatAvatarSize == 80)
        #expect(workspace.settings.botLook == .original)
        workspace.setChatAvatarSize(999)
        #expect(AppSettings.load(from: workspace.settingsURL).chatAvatarSizeChoice == 96)
        workspace.setChatAvatarSize(-100)
        #expect(workspace.settings.chatAvatarSizeChoice == 32)
        workspace.setChatAvatarSize(nil)
        #expect(open().settings.chatAvatarSizeChoice == nil)
        withExtendedLifetime(subscription) {}
    }

    @Test func sizeChangesReachPayloadPatchesAndNewChats() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "ccb-avatar-payload-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = Workspace(root: root) { profile, store in Bot(profile: profile, launcher: FakeLauncher().launcher, store: store) }
        func payload() -> ChatPayload {
            ChatPayload.make(bot: workspace.mainBot, components: nil, pending: [], replyingTo: nil,
                             chatAvatarSize: workspace.settings.chatAvatarSizeChoice) { _ in "avatar" }
        }
        var patcher = ChatPayload.Patcher()
        #expect(!payload().json().contains("chatAvatarSize"))
        _ = patcher.script(for: payload())
        workspace.setChatAvatarSize(96)
        let sizePatch = patcher.script(for: payload())
        let script = try #require(sizePatch)
        #expect(script.contains("\"chatAvatarSize\":96"))
        #expect(script.contains("\"changed\":[]"))
        #expect(payload().json().contains("\"chatAvatarSize\":96"))
        let unchanged = patcher.script(for: payload())
        #expect(unchanged == nil)
        workspace.setChatAvatarSize(nil)
        let reset = patcher.script(for: payload())
        #expect(try #require(reset).contains("\"base\":"))
        let watched = Subagent(id: "sample", description: "Sample", prompt: "Synthetic task")
        let subagent = ChatPayload.make(subagent: watched, of: workspace.mainBot, components: nil, avatar: "avatar", chatAvatarSize: 999)
        #expect(subagent.json().contains("\"chatAvatarSize\":96"))
    }
}
