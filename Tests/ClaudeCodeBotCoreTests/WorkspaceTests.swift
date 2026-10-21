import Foundation
import Testing
@testable import ClaudeCodeBotCore

@MainActor
struct WorkspaceTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-ws-\(UUID().uuidString)")

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

    @Test func addingAFolderGivesItAManagerWithIgnoredNotes() throws {
        let workspace = makeWorkspace(FakeLauncher())
        let project = workspace.addProject(folder: try makeFolder("NotchDo"))

        #expect(project.name == "NotchDo")
        #expect(workspace.selection == project.id)
        let manager = try #require(workspace.bot(for: project))
        #expect(manager.profile.role == .manager)
        #expect(manager.profile.workingDirectory == project.folder)
        #expect(manager.profile.memoryPath == ".bot/memory.md")
        let ignore = try String(contentsOf: project.notesFolder.appending(path: ".gitignore"), encoding: .utf8)
        #expect(ignore == "*\n")
    }

    @Test func addingTheSameFolderTwiceKeepsOneProject() throws {
        let workspace = makeWorkspace(FakeLauncher())
        let folder = try makeFolder("blog")
        let first = workspace.addProject(folder: folder)
        let second = workspace.addProject(folder: folder)
        #expect(first.id == second.id)
        #expect(workspace.projects.count == 1)
    }

    @Test func projectsAndShapesSurviveARestart() throws {
        let fake = FakeLauncher()
        let workspace = makeWorkspace(fake)
        workspace.addProject(folder: try makeFolder("a"))
        workspace.addProject(folder: try makeFolder("b"))

        let reopened = makeWorkspace(fake)
        #expect(reopened.projects.map(\.name) == ["a", "b"])
        #expect(reopened.projects.map(\.avatar) == ["square", "triangle"])
    }

    @Test func askingForStatusWakesOnlyTheMainBotWithTheProjectList() async throws {
        let fake = FakeLauncher()
        let workspace = makeWorkspace(fake)
        let project = workspace.addProject(folder: try makeFolder("NotchDo"))
        workspace.select(nil)

        workspace.mainBot.send("How is NotchDo doing?")
        await eventually { workspace.mainBot.messages.count == 2 }

        #expect(fake.agents.count == 1)
        let launch = fake.agents[0].launch
        #expect(launch.extraDirectories == [project.notesFolder, workspace.maintainerProject.notesFolder])
        let wake = try #require(fake.agents[0].sent.first)
        #expect(wake.contains(project.notesFolder.appending(path: "memory.md").path))
        #expect(wake.contains(project.inboxURL.path))
        #expect(wake.hasSuffix("How is NotchDo doing?"))
    }

    @Test func inboxWrittenByTheMainBotIsRelayedToTheManager() async throws {
        let fake = FakeLauncher()
        let workspace = makeWorkspace(fake)
        let project = workspace.addProject(folder: try makeFolder("blog"))
        // The main bot "writes" the inbox while answering.
        fake.respond = { text in
            if text.contains("portfolio") && !text.contains(BotPrompts.relayPrefix) {
                try? "Add a portfolio section to the home page.\n".write(to: project.inboxURL, atomically: true, encoding: .utf8)
                return "Handed to blog."
            }
            return "Got it"
        }

        workspace.mainBot.send("Add a portfolio section to the blog home page")
        let manager = try #require(workspace.bot(for: project))
        await eventually { manager.messages.count == 2 }

        #expect(manager.messages.map(\.role) == [.relay, .bot])
        #expect(manager.messages[0].text == "Add a portfolio section to the home page.")
        #expect(fake.agents.count == 2)
        #expect(fake.agents[1].launch.workingDirectory == project.folder)
        #expect(fake.agents[1].sent.first?.contains(BotPrompts.relayPrefix + "Add a portfolio section to the home page.") == true)
        let inbox = try String(contentsOf: project.inboxURL, encoding: .utf8)
        #expect(inbox.isEmpty)
    }

    @Test func waitingComesFromManagersMemoryWithoutWakingThem() throws {
        let fake = FakeLauncher()
        let workspace = makeWorkspace(fake)
        let project = workspace.addProject(folder: try makeFolder("blog"))
        try """
        ## Current status
        Waiting on you to pick cover images.
        ## Waiting on you
        - 40 old posts have no cover image. What should we do?
        ## Decided
        - 2026-10-18 Use Astro
        """.write(to: project.notesFolder.appending(path: "memory.md"), atomically: true, encoding: .utf8)

        workspace.refreshWaiting()

        #expect(workspace.waiting == [Workspace.Waiting(projectID: project.id, text: "40 old posts have no cover image. What should we do?")])
        #expect(fake.agents.isEmpty)
    }

    @Test func memorySectionsSkipPlaceholders() {
        let text = """
        ## Current status (3 sentences max)
        Working on the error states.
        ## Waiting on you
        (none)
        ## In progress
        1. Error states
        * Scheduling
        """
        #expect(MemoryFile.items(in: text, section: .waitingOnYou).isEmpty)
        #expect(MemoryFile.items(in: text, section: .inProgress) == ["Error states", "Scheduling"])
        #expect(MemoryFile.items(in: text, section: .currentStatus) == ["Working on the error states."])
    }

    @Test func managersGetCodingToolsAndTheMainBotDoesNot() {
        let main = BotProfile.main(home: URL(filePath: "/tmp/main"))
        let manager = BotProfile.manager(name: "x", avatar: "square", folder: URL(filePath: "/tmp/x"))
        #expect(!main.tools.contains("Bash"))
        #expect(manager.tools.contains("Bash"))
    }
}
