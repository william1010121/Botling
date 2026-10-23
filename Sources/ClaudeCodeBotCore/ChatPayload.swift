import Foundation

/// What the web chat surface draws: the chat as plain values, encoded to JSON for
/// `ccb.setState(...)`. Field names match `Web/src/types.ts`.
public struct ChatPayload: Encodable, Equatable {
    public struct Choice: Encodable, Equatable {
        var label: String
        var detail: String?
        var recommended: Bool
        /// A tool question's button: what it does (`Choice.Action`), apart from its words.
        var action: String?
    }

    public struct File: Encodable, Equatable {
        var id: String?
        var name: String
        var kind: String
        var url: String
    }

    public struct Message: Encodable, Equatable {
        var id: String
        var role: String
        var text: String
        var stamp: String?
        var avatar: String?
        var choices: [Choice]?
        var chosen: Int?
        var answer: String?
        var open: Bool
        /// The components it shows, each with where in `text` it goes.
        var displays: [Display]?
        var attachments: [File]?
        var replyTo: String?
        var replyPreview: String?
        var openable: Bool
        /// Who said it, above the bubble (a group chat, or a bot called into this one with @).
        var speaker: String?
        /// What the bot did on the way to this reply.
        var steps: [StepView]?
        /// Result pages it links to, drawn as 「網頁預覽卡片」 cards under it.
        var previews: [Display]?
        /// A "not right" report handed over: shown as who it is about and the user's words, with
        /// `text` (the chat around it) folded.
        var feedback: Feedback?
        /// Component specs made from it: a quiet chip each, under the reply.
        var specs: [SpecChip]? = nil
        /// The library component the reply already is ("Add to another bot…" instead of "Make
        /// into component").
        var component: String? = nil
        /// The chat's background work (all that runs, and what finished since your latest line), on
        /// the bot's latest reply only (nil on the others): one row of counts (subagents, waiting,
        /// done, failed) that moves down as replies arrive.
        var tasks: [TaskChip]? = nil
        /// claude.ai Artifacts it links to, drawn as cards under it (the links stay chips too).
        var artifacts: [ArtifactLink.Card]? = nil
        /// Before your latest line: its finished subagents leave the folded steps line (the
        /// unfolded steps still list them).
        var earlier: Bool? = nil
        /// A call auto mode blocked that a subagent made: which one (drawn above the card, with
        /// a way to open it).
        var fromSubagent: SubagentRef? = nil
        /// In a bot with two heads: each head, and whether this line has reached it ("C", "X").
        var seen: [Seen]? = nil
        /// When it was sent, in a subagent's view: its task and each message its bot sent it
        /// ("From Main · 15:58").
        var time: String? = nil
    }

    public struct SubagentRef: Encodable, Equatable {
        var id: String
        var title: String
    }

    /// Background work under a reply: a command or a subagent, with how it is doing. Times are
    /// milliseconds since 1970, so the page can count the time it has been running.
    public struct TaskChip: Encodable, Equatable {
        var id: String
        var kind: String
        var title: String
        /// running, completed, failed, killed, stopped (its bot's process ended) or interrupted
        /// (the app restarted).
        var status: String
        var started: Double
        var ended: Double?
        /// The command or the subagent's task, for the chip's tooltip.
        var detail: String?
        /// The message whose turn started it (its output is asked for by that message's id).
        var message: String
        /// A wake-up's or one-shot cron job's time (ms since 1970).
        var fires: Double?
        /// A cron job's five fields, and whether it fires on every match.
        var schedule: String?
        var recurring: Bool?

        init(_ task: BackgroundTask, from messageID: UUID) {
            message = messageID.uuidString
            id = task.id
            kind = task.kind.rawValue
            title = task.title
            status = task.status.rawValue
            started = (task.startedAt.timeIntervalSince1970 * 1000).rounded()
            ended = task.endedAt.map { ($0.timeIntervalSince1970 * 1000).rounded() }
            detail = task.detail
            fires = task.fireAt.map { ($0.timeIntervalSince1970 * 1000).rounded() }
            schedule = task.schedule
            recurring = task.recurring
        }
    }

    /// A component made from a reply, under it: a chip while it is a suggestion or being built
    /// (pressed: a suggestion starts its build, otherwise the spec opens in the right panel), then
    /// the component itself with "Edit spec".
    public struct SpecChip: Encodable, Equatable {
        var id: String
        var name: String
        var status: String
        /// A bot suggested it (nothing has run or been built).
        var suggested: Bool
        /// It shows in the right panel now.
        var open: Bool
        /// The library component it became, drawn under the reply (also while a new version
        /// builds), with its command's run as for any card.
        var component: String? = nil
        var display: Display? = nil
        /// The bot that wrote the reply is drawing the built component for it now (its name).
        var filling: String? = nil
    }

    public struct Feedback: Encodable, Equatable {
        var about: String
        var words: String
    }

    /// One line of work, as the page draws it. A subagent's line carries how it is doing.
    public struct StepView: Encodable, Equatable {
        var id: String
        var kind: String
        var tool: String?
        var title: String
        var detail: String?
        var output: String?
        var failed: Bool
        var done: Bool
        /// For a subagent: running, completed, failed or stopped, and its tool calls so far.
        var status: String?
        var count: Int?
        /// The pictures it gave back, drawn in its OUT box; click one to open it full size.
        var images: [StepImage]? = nil
    }

    /// A picture a tool call gave back: the `file:` URL the page loads, and its name.
    public struct StepImage: Encodable, Equatable {
        var url: String
        var name: String
        /// A small copy to show in the chat (`url` opens when it is clicked); nil to show `url`.
        var thumb: String? = nil
    }

    /// The top of the page while you look at a subagent (no input box: you only watch it).
    public struct SubagentHeader: Encodable, Equatable {
        var id: String
        var title: String
        var owner: String
        var status: String
        var type: String?
        /// The head whose trace/store owns it: "claude" or "codex", for its badge.
        var engine: String = "claude"
        /// Its model when known ("Sonnet"): what its Agent call asked for, else its bot's
        /// subagent model.
        var model: String? = nil
                outputTokens: subagent.reportedOutputTokens,
                startedAt: subagent.startedAt.timeIntervalSince1970 * 1000,
                endedAt: subagent.endedAt.map { $0.timeIntervalSince1970 * 1000 }
