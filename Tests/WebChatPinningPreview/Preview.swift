import AppKit
import ClaudeCodeBotCore
import SwiftUI

/// Isolated renderer of the production Web provider rows, with synthetic conversations only.
@main
@MainActor
struct WebChatPinningPreview {
    static var windows: [NSWindow] = []

    static func main() {
        let app = NSApplication.shared
        HeadlessRun.quiet(app)
        let output = URL(filePath: CommandLine.arguments[1])
        let root = output.appending(path: "fixture")
        let workspace = Workspace(root: root) { profile, store in
            Bot(profile: profile, launcher: { _ in throw AppError.claudeNotFound }, store: store)
        }
        L10n.language = .traditionalChinese
        let shelf = workspace.web
        let work = shelf.addAccount(on: .gemini, name: "Work")
        let page = UUID()
        shelf.attach(page, account: work)
        let now = Date(timeIntervalSince1970: 1_792_655_000)
        for index in 1...7 {
            let id = "sample-\(index)"
            let ownPage = index == 1 ? page : UUID()
            shelf.record(on: .gemini, page: ownPage, url: WebSite.gemini.conversationURL(id), pageTitle: nil,
                         reading: .read(title: index == 1 ? "研究計畫與實驗紀錄 · Work" : "合成對話 \(index) · Gemini",
                                        turns: [WebTurn(role: .user, text: "Sample question"), WebTurn(role: .assistant, text: "Sample answer")]),
                         now: now.addingTimeInterval(Double(index)))
            if index <= 5, let row = shelf.conversation(id, of: .gemini) {
                shelf.setPinned(true, conversation: row, of: .gemini, now: now.addingTimeInterval(Double(index)))
            }
        }
        for site in [WebSite.chatgpt, .claude, .grok] {
            for index in 1...2 {
                let id = "sample-\(index)"
                shelf.record(on: site, page: UUID(), url: site.conversationURL(id), pageTitle: nil,
                             reading: .read(title: index == 1 ? "\(site.name) 的固定對話" : "\(site.name) 最近的對話",
                                            turns: [WebTurn(role: .user, text: "Sample question"), WebTurn(role: .assistant, text: "Sample answer")]),
                             now: now.addingTimeInterval(Double(index)))
                if index == 1, let row = shelf.conversation(id, of: site) {
                    shelf.setPinned(true, conversation: row, of: site, now: now)
                }
            }
        }
        if let selected = shelf.conversation("sample-1", of: .gemini) { workspace.open(selected, on: .gemini) }
        for width in [280, 200] { draw(workspace, width: width, to: output.appending(path: "sidebar-\(width).png")) }
        let before = shelf.front
        let requested = shelf.requested
        if let selected = shelf.conversation("sample-1", of: .gemini) { shelf.setPinned(false, conversation: selected, of: .gemini) }
        precondition(before == shelf.front && requested == shelf.requested, "Pin action changed page navigation")
        draw(workspace, width: 280, to: output.appending(path: "sidebar-unpinned.png"))
        print("Rendered production WebRailSection: 280pt, 200pt, unpinned; synthetic only; page navigation unchanged")
        exit(0)
    }

    static func draw(_ workspace: Workspace, width: Int, to path: URL) {
        let content = VStack(alignment: .leading, spacing: 2) {
            Text("SAMPLE DATA · \(width) pt")
                .font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.faint).padding(.horizontal, 10)
            WebRailSection(workspace: workspace)
            Spacer(minLength: 0)
        }
        .padding(8).frame(width: CGFloat(width), height: 780)
        .foregroundStyle(Theme.text).background(Theme.side).preferredColorScheme(.dark)
        let host = NSHostingView(rootView: content)
        host.frame = NSRect(x: 0, y: 0, width: width, height: 780)
        let window = HeadlessRun.offscreenWindow(host.frame)
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = host
        windows.append(window)
        RunLoop.main.run(until: Date().addingTimeInterval(1))
        host.layoutSubtreeIfNeeded()
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { fatalError("Missing bitmap") }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("Missing PNG") }
        do { try png.write(to: path) } catch { fatalError("\(error)") }
    }
}
