import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// The main bot makes a folder a project: you confirm on a card, then its manager gets the task.
@MainActor
struct NewProjectTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-np-\(UUID().uuidString)")

    func makeWorkspace(_ fake: FakeLauncher) -> Workspace {
        Workspace(root: root.appending(path: "ccb")) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    func makeFolder(_ name: String) throws -> URL {
        let folder = root.appending(path: "code/\(name)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    @Test func theTagIsRead() {
        let parsed = ReplyParser.parseAll(#"Asked to add garden. <new-project folder="~/code/garden">Fix the login page</new-project>"#)
        #expect(parsed.body == "Asked to add garden.")
        #expect(parsed.requests == [.newProject(folder: "~/code/garden", task: "Fix the login page")])
        let bare = ReplyParser.parseAll(#"Asked. <new-project folder="/tmp/x"/>"#)
        #expect(bare.requests == [.newProject(folder: "/tmp/x", task: "")])
        let inCode = ReplyParser.parseAll("Write `<new-project folder=\"/tmp/x\"/>` to do it.")
        #expect(inCode.requests.isEmpty)
    }

    @Test func pathsAreReadLikeAShellWould() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        #expect(Workspace.folderURL("~/code/garden")?.path == home + "/code/garden")
        #expect(Workspace.folderURL("file:///tmp/a%20b/")?.path == "/tmp/a b")
        #expect(Workspace.folderURL("code/garden") == nil)
    }

    @Test func addingWaitsForYourPickThenHandsOverTheTask() async throws {
        let fake = FakeLauncher()
        let workspace = makeWorkspace(fake)
        let folder = try makeFolder("garden")
        workspace.handle([.newProject(folder: folder.path, task: "Fix the login page")], from: nil)

        #expect(workspace.projects.isEmpty)
        let card = try #require(workspace.mainBot.messages.last)
        #expect(card.isOpenQuestion)
        #expect(card.text.contains(folder.path))
        #expect(card.choices?.first?.label == "Add as project")

        #expect(workspace.choose(0, in: card.id, of: workspace.mainBot))
        let project = try #require(workspace.projects.first)
        #expect(project.folder.path == folder.path)
        // You stay in the main bot's chat.
        #expect(workspace.selection == nil)
        let manager = try #require(workspace.bot(for: project))
        await eventually { manager.messages.first?.role == .relay }
        #expect(manager.messages.first?.text == "Fix the login page")
        #expect(workspace.mainBot.messages.last?.text.hasPrefix("Added garden") == true)
        // A second pick on the same card does nothing.
        #expect(!workspace.choose(0, in: card.id, of: workspace.mainBot))
    }

    @Test func severalFoldersInOneReplyAreAskedAboutOnOneCard() async throws {
        let fake = FakeLauncher()
        let workspace = makeWorkspace(fake)
        let known = workspace.addProject(folder: try makeFolder("known"), select: false)
        let a = try makeFolder("alpha"), b = try makeFolder("beta")
        let parsed = ReplyParser.parseAll("""
        Asked to add alpha and beta.
        <new-project folder="\(a.path)">List the files</new-project>
        <new-project folder="\(b.path)"/>
        <new-project folder="\(root.appending(path: "code/known").path)">Say hi</new-project>
        <new-project folder="\(root.appending(path: "code/ghost").path)"/>
        """)
        workspace.handle(parsed.requests, from: nil)

        let cards = workspace.mainBot.messages.filter(\.isOpenQuestion)
        #expect(cards.count == 1)
        let card = try #require(cards.first)
        #expect(card.text.hasPrefix("Add these 2 folders as projects?"))
        #expect(card.text.contains("**alpha**") && card.text.contains("**beta**") && card.text.contains("then: List the files"))
        #expect(card.choices?.first?.label == "Add all 2")
        #expect(workspace.mainBot.messages.contains { $0.text.contains("there is no folder at") })
        let knownManager = try #require(workspace.bot(for: known))
        await eventually { knownManager.messages.first?.text == "Say hi" }

        #expect(workspace.choose(0, in: card.id, of: workspace.mainBot))
        #expect(workspace.projects.map(\.name) == ["known", "alpha", "beta"])
        let alpha = try #require(workspace.projects.first { $0.name == "alpha" }.flatMap(workspace.bot(for:)))
        await eventually { alpha.messages.first?.text == "List the files" }
        let beta = try #require(workspace.projects.first { $0.name == "beta" }.flatMap(workspace.bot(for:)))
        #expect(beta.messages.isEmpty)
        #expect(workspace.mainBot.messages.last?.text == "Added alpha, beta as projects; the managers with a task are on it.")
    }

    @Test func everyFolderInsideAFolderIsFoundByTheApp() async throws {
        let workspace = makeWorkspace(FakeLauncher())
        for name in ["beta", "alpha", ".hidden"] { _ = try makeFolder("tool/\(name)") }
        try Data().write(to: root.appending(path: "code/tool/notes.txt"))
        let known = workspace.addProject(folder: try makeFolder("tool/known"), select: false)

        workspace.handle(ReplyParser.parseAll(#"Asked. <new-project folder="\#(root.appending(path: "code/tool").path)/*">Say what you are</new-project>"#).requests, from: nil)
        let card = try #require(workspace.mainBot.messages.last { $0.isOpenQuestion })
        #expect(card.choices?.first?.label == "Add all 2")
        #expect(card.text.contains("**alpha**") && card.text.contains("**beta**"))
        #expect(!card.text.contains("hidden") && !card.text.contains("notes.txt") && !card.text.contains("**known**"))
        // The one that was a project already got its task straight away.
        let manager = try #require(workspace.bot(for: known))
        await eventually { manager.messages.first?.text == "Say what you are" }

        workspace.handle([.newProject(folder: root.appending(path: "code/nothing").path + "/*", task: "")], from: nil)
        #expect(workspace.mainBot.messages.last?.text.contains("there is no folder at") == true)
    }

    @Test func everyProjectBelowAFolderIsFoundHoweverDeep() async throws {
        let workspace = makeWorkspace(FakeLauncher())
        func project(_ path: String, marker: String) throws {
            let folder = try makeFolder(path)
            try FileManager.default.createDirectory(at: folder.appending(path: marker == ".git" ? ".git" : "x"), withIntermediateDirectories: true)
            if marker != ".git" { try Data().write(to: folder.appending(path: marker)) }
        }
        try project("tool/MacOSApp/ClaudeCodeBot", marker: ".git")
        try project("tool/MacOSApp/ClaudeCodeBot/Web", marker: "package.json")
        try project("tool/MacOSApp/TODO/NotchDo", marker: "Package.swift")
        try project("tool/cli/token-speed", marker: "Cargo.toml")
        try project("tool/cli/token-speed/node_modules/dep", marker: "package.json")
        _ = try makeFolder("tool/website/empty")
        let tool = root.appending(path: "code/tool")
        #expect(Workspace.projectFolders(in: tool).map(\.lastPathComponent) == ["token-speed", "ClaudeCodeBot", "NotchDo"])

        workspace.handle([.newProject(folder: tool.path + "/**", task: "Write down what you are")], from: nil)
        let card = try #require(workspace.mainBot.messages.last { $0.isOpenQuestion })
        #expect(card.choices?.first?.label == "Add all 3")
        // One task for all is said once.
        #expect(card.text.components(separatedBy: "Write down what you are").count == 2)
        #expect(card.text.contains("Then each manager starts on: Write down what you are"))
    }

    @Test func everyBotHasTheSameToolsOnlyCommandsAskOutsideProjects() {
        let folder = root.appending(path: "x")
        let profiles = [
            BotProfile.main(home: root),
            .manager(name: "p", avatar: "square", folder: folder),
            .standalone(name: "b", avatar: "star", folder: folder, job: "news"),
            .maintainer(folder: folder, instructions: ""),
        ]
        for profile in profiles {
            #expect(Set(profile.tools).subtracting(["Bash"]) == Set(BotProfile.toolbox))
            #expect(profile.disallowedTools.isEmpty)
        }
        #expect(profiles.map { $0.tools.contains("Bash") } == [false, true, false, true])
    }

    @Test func theMainBotNeedsNoFilesToAddProjectsAndMaySearchItsArchive() {
        let main = BotProfile.main(home: root)
        #expect(main.tools.contains("Grep"))
        let system = BotPrompts(profile: main).system
        #expect(system.contains(#"write folder="~/tool/**""#))
        #expect(system.contains("that is a project, not 4"))
        #expect(system.contains("search it with Grep there"))
    }

    @Test func wordsOnTheCardCloseItAndTheBotIsToldPlainly() async throws {
        let fake = FakeLauncher()
        fake.respond = { _ in "Noted." }
        let workspace = makeWorkspace(fake)
        let folder = try makeFolder("cli")
        workspace.handle([.newProject(folder: folder.path, task: "")], from: nil)
        let card = try #require(workspace.mainBot.messages.last { $0.isOpenQuestion })

        #expect(workspace.answer("I meant every project, not these folders", in: card.id, of: workspace.mainBot))
        await eventually { workspace.mainBot.messages.last?.text == "Noted." }
        let sent = try #require(fake.agents.last?.sent.last)
        #expect(sent.contains("(App: The user wrote this on the app's card asking to add cli as projects instead of picking an option. That card is closed and nothing was done."))
        #expect(sent.contains("(Replying to the app's message: \"Add **cli** as a project?\")"))
        #expect(sent.hasSuffix("I meant every project, not these folders"))
        // The card no longer adds anything.
        #expect(!workspace.choose(0, in: card.id, of: workspace.mainBot))
        #expect(workspace.projects.isEmpty)
    }

    @Test func saying_noAddsNothing() throws {
        let workspace = makeWorkspace(FakeLauncher())
        let folder = try makeFolder("blog")
        workspace.handle([.newProject(folder: folder.path, task: "")], from: nil)
        let card = try #require(workspace.mainBot.messages.last)
        #expect(workspace.choose(1, in: card.id, of: workspace.mainBot))
        #expect(workspace.projects.isEmpty)
    }

    @Test func aFolderThatIsAlreadyAProjectJustGetsTheTask() async throws {
        let workspace = makeWorkspace(FakeLauncher())
        let folder = try makeFolder("shop")
        let project = workspace.addProject(folder: folder)
        workspace.handle([.newProject(folder: folder.path + "/", task: "Add a cart")], from: nil)
        #expect(workspace.projects.count == 1)
        #expect(workspace.mainBot.messages.last?.isOpenQuestion == false)
        let manager = try #require(workspace.bot(for: project))
        await eventually { manager.messages.first?.text == "Add a cart" }
    }

    @Test func missingOrTooBroadFoldersAreRefused() throws {
        let workspace = makeWorkspace(FakeLauncher())
        workspace.handle([.newProject(folder: root.appending(path: "nope").path, task: "")], from: nil)
        #expect(workspace.mainBot.messages.last?.text.contains("there is no folder") == true)
        workspace.handle([.newProject(folder: "~", task: "")], from: nil)
        #expect(workspace.mainBot.messages.last?.text.contains("far more than one project") == true)
        try FileManager.default.createDirectory(at: root.appending(path: "ccb/bots"), withIntermediateDirectories: true)
        workspace.handle([.newProject(folder: root.appending(path: "ccb/bots").path, task: "")], from: nil)
        #expect(workspace.mainBot.messages.last?.text.contains("far more than one project") == true)
        #expect(workspace.projects.isEmpty)
        #expect(workspace.mainBot.messages.allSatisfy { !$0.isOpenQuestion })
    }

    @Test func onlyTheMainBotAddsProjects() throws {
        let workspace = makeWorkspace(FakeLauncher())
        let owner = workspace.addProject(folder: try makeFolder("one"))
        let other = try makeFolder("two")
        workspace.handle([.newProject(folder: other.path, task: "")], from: owner)
        #expect(workspace.mainBot.messages.isEmpty)
        #expect(workspace.projects.count == 1)
    }

    @Test func theMainBotSeesEachProjectsFolder() throws {
        let workspace = makeWorkspace(FakeLauncher())
        let folder = try makeFolder("garden")
        workspace.addProject(folder: folder)
        #expect(workspace.projectBriefing().contains("garden (folder \(folder.standardizedFileURL.path))"))
    }
}
