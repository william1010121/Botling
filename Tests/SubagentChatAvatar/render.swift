import AppKit
import ClaudeCodeBotCore
import SwiftUI

/// Synthetic native sidebar fixture. The runner compiles the unmodified production row
/// declarations and avatar views with the built Core objects; no app or user store is opened.
@main
struct SubagentAvatarRender {
    @MainActor static func main() throws {
        HeadlessRun.quiet(NSApplication.shared)
        let output = URL(filePath: CommandLine.arguments[1])
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        var failures: [String] = []
        for engine in BotEngine.allCases {
            for twoHeads in [false, true] {
                let root = output.appending(path: "fixture-\(engine)-\(twoHeads)")
                let store = BotStore(directory: Workspace.Layout.mainBot(in: root))
                store.save(engine: engine)
                store.save(heads: HeadsSettings(engines: twoHeads ? [.claude, .codex] : [engine]))
                let child = Subagent(id: "child", description: "Diagnose CV vs replay gap", type: "unrelated-agent-name", prompt: "Synthetic avatar test", status: .completed)
                store.save(subagents: [child])
                if twoHeads {
                    let other: BotEngine = engine == .claude ? .codex : .claude
                    BotStore(directory: store.directory.appending(path: "partner-\(other.rawValue)")).save(subagents: [Subagent(id: "partner", description: "Partner origin", prompt: "Synthetic test", status: .completed)])
                }
                let workspace = Workspace(root: root) { profile, store in
                    Bot(profile: profile, launcher: { _ in throw URLError(.cancelled) }, store: store)
                }
                let bot = workspace.mainBot
                for child in bot.subagents {
                    for look in BotLook.allCases {
                        for selected in [false, true] {
                            if selected { workspace.view(subagent: child.id, of: bot) } else { workspace.select(nil) }
                            for width in [180.0, 240.0] {
                                let name = "\(engine)-\(twoHeads ? "both" : "solo")-\(child.id)-\(look)-\(selected ? "selected" : "plain")-\(Int(width))"
                                let row = SubagentRow(subagent: child, bot: bot, workspace: workspace)
                                    .environment(\.botLook, look).frame(width: width, height: 36)
                                    .background(Theme.side).preferredColorScheme(.dark)
                                let host = NSHostingView(rootView: row)
                                let window = HeadlessRun.offscreenWindow(NSRect(x: 0, y: 0, width: width, height: 36))
                                window.appearance = NSAppearance(named: .darkAqua)
                                host.frame = NSRect(x: 0, y: 0, width: width, height: 36)
                                window.contentView = host
                                host.layoutSubtreeIfNeeded()
                                RunLoop.main.run(until: Date().addingTimeInterval(0.1))
                                guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { fatalError("bitmap unavailable") }
                                host.cacheDisplay(in: host.bounds, to: rep)
                                try rep.representation(using: .png, properties: [:])!.write(to: output.appending(path: name + ".png"))
                                // A branch arrow and title are neutral gray; a real head or bot face
                                // has colored pixels in the fixed avatar slot after the arrow.
                                let scale = Double(rep.pixelsWide) / width
                                var colored = 0
                                for y in Int(5 * scale)..<Int(31 * scale) {
                                    for x in Int(44 * scale)..<Int(72 * scale) {
                                        if let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB),
                                           c.alphaComponent > 0.5, c.saturationComponent > 0.3, c.brightnessComponent > 0.3 { colored += 1 }
                                    }
                                }
                                if colored < 12 { failures.append("\(name): missing avatar (\(colored) colored pixels)") }
                                if host.fittingSize.width > width + 0.5 { failures.append("\(name): overflow \(host.fittingSize.width)") }
                                print("\(colored >= 12 ? "PASS" : "FAIL") \(name) avatarPixels=\(colored), width=\(host.fittingSize.width)")
                            }
                        }
                    }
                }
            }
        }
        if !failures.isEmpty {
            for failure in failures { fputs(failure + "\n", stderr) }
            exit(1)
        }
    }
}
