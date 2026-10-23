// Synthetic replay using actual Core payload/relay code and supplied character art.
import Foundation
@testable import ClaudeCodeBotCore

@main struct Fixture {
    @MainActor static func main() async throws {
        let output = URL(filePath: CommandLine.arguments[1])
        let root = output.appending(path: "synthetic-workspace")
        try? FileManager.default.removeItem(at: root)
        let workspace = Workspace(root: root) { profile, store in
            Bot(profile: profile, launcher: { _ in throw CocoaError(.featureUnsupported) }, store: store)
        }
        let host = workspace.mainBot
        await host.setHeads([.claude, .codex])
        await workspace.maintainer.setHeads([.codex])
        let green = Chibi.Hat(path: "M22.5 11 Q22.5 4 28 5 Q28 0 32 2 Q36 0 36 5 Q41.5 4 41.5 11 L41.5 17 L22.5 17 Z", color: "#B5E43A", eyes: [(29.3, 10.6), (34.7, 10.6)])
        let purple = Chibi.Hat(path: "M32 1.88 L41.12 11 L32 20.12 L22.88 11 Z", color: "#9B5CF0", eyes: [(29.3, 10.6), (34.7, 10.6)])
        func look(_ hat: Chibi.Hat) -> ChatPayload.HeadLook {
            func avatar(_ engine: BotEngine, _ mood: Chibi.Mood = .normal) -> String { Chibi.dataURL(Chibi.svg(engine, mood: mood, hat: hat)) }
            return ChatPayload.HeadLook(avatar: { avatar($0) }, mark: { Chibi.dataURL(Chibi.svg($0)) }, animations: BotEngine.allCases.map { head in
                ChibiAnimation.Head(engine: head.rawValue, avatar: avatar(head), thinking: avatar(head, .think), sleeping: avatar(head, .sleep),
                    hat: Chibi.dataURL("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>" + Chibi.hatSVG(hat) + "</svg>"),
                    clips: ChibiAnimation.clips.filter { $0.engine == head.rawValue })
            })
        }
        func icon(_ hat: Chibi.Hat) -> String {
            Chibi.dataURL("<svg xmlns='http://www.w3.org/2000/svg' viewBox='21 0 22 22'><path d='\(hat.path)' fill='\(hat.color)' stroke='\(hat.color)' stroke-width='1.2' stroke-linejoin='round'/><ellipse cx='29.3' cy='10.6' rx='2' ry='2.5' fill='white'/><ellipse cx='34.7' cy='10.6' rx='2' ry='2.5' fill='white'/><circle cx='29.3' cy='10.6' r='1.1'/><circle cx='34.7' cy='10.6' r='1.1'/></svg>")
        }
        var own = ChatMessage(role: .bot, text: "我查過了：Maintainer 的卡片還沒做出來，卡在缺資料來源，它在等我們提供讀取目前在跑哪些 subagent 的方法。\n\n這個缺口已補上，剛剛實際跑，抓到 **Claude 1 個、Codex 1 個** 正在工作，和現在的實際狀況一致。現在交給 Maintainer 接成卡片。")
        own.engine = .claude; own.seenBy = [.claude]
        host.post(own)
        let member = workspace.everyMember.first { $0.id == Workspace.maintainerID }!
        let text = "已接續原任務處理，會把需要 App 配合的部分交回 botling 專案接通，再完成卡片、核對兩邊的即時人數。目前還沒接好。"
        _ = await workspace.postGuestReply(text, steps: nil, from: member, bot: workspace.maintainer, into: host, seen: true,
            policy: .init(passes: false, tagsAct: false)) { workspace.maintainer.keepCallIn(asked: "@Maintainer", at: Date(), reply: $0) }
        func payload(_ cute: Bool, live: Bool = false) -> ChatPayload {
            ChatPayload.make(bot: host, components: nil, pending: [], replyingTo: nil,
                callIn: ChatPayload.GroupView(typing: live ? Workspace.maintainerID : nil, working: live ? workspace.maintainer : nil) { _ in "Maintainer" },
                look: cute ? look(green) : nil, sourceLook: { _ in cute ? look(purple) : nil }, chatAvatarSize: 48,
                avatar: { $0 == nil ? icon(green) : icon(purple) })
        }
        func write(_ name: String, _ payload: ChatPayload, before: Bool = false) throws {
            var json = try JSONSerialization.jsonObject(with: Data(payload.json().utf8)) as! [String: Any]
            json["botName"] = "botling"; json["lang"] = "zh-Hant"; json["placeholder"] = "合成重播，未連接模型"
            json["avatarMood"] = "normal"
            var messages = (json["messages"] as! [[String: Any]]).filter { $0["role"] as? String == "bot" }
            messages[0]["speaker"] = "botling · Claude"
            if before { messages[1]["avatar"] = icon(purple); messages[1]["speaker"] = "Maintainer" }
            json["messages"] = messages
            try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys]).write(to: output.appending(path: name + ".json"))
        }
        try write("before", payload(true), before: true)
        try write("after", payload(true))
        try write("original", payload(false))
        try write("live", payload(true, live: true))
        print("PASS: synthetic fixtures from actual postGuestReply + ChatPayload, known source Codex; before reconstructs missing legacy metadata")
    }
}
