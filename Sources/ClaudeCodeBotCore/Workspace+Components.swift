import Foundation

/// Each bot's own components. Every component is on Maintainer's shelf (the shared library,
/// `ComponentLibrary`); a bot has a list of at most `ComponentLibrary.limit` of them, kept in its
/// bot.json (`Bot.componentList`). Its briefing has the whole usage of those and one line for each
/// of the rest, so it knows they exist and can ask Maintainer for one.
extension Workspace {
    /// The bots that keep a list: the main bot, the projects' managers, the bots of their own and
    /// Maintainer (not Codex, not group chats).
    var botsWithComponents: [Bot] { [mainBot] + Array(managers.values) }

    /// `bot`'s components that are in the library, in the library's order.
    public func ownComponents(of bot: Bot) -> [String] {
        let own = Set(bot.componentList ?? [])
        return components.names.filter(own.contains)
    }

    /// The components `bot` (the main bot when nil) can draw or ask for.
    func componentBriefing(for bot: Bot? = nil) -> String {
        let bot = bot ?? mainBot
        let own = ownComponents(of: bot)
        let others = components.names.filter { !own.contains($0) }
        let limit = ComponentLibrary.limit
        var text = "(App: Components in the chat: \(own.count) / \(limit) yours, each with its usage below (a bot has at most \(limit)). <show name=\"name\">JSON</show> draws one; <show name=\"name\" command=\"git diff --stat\"></show> fills it with what that command prints instead (run in your project folder once the user allows it; JSON output is used as the data, other output as one string; the card has a refresh button). A component whose usage has a \"Command:\" line needs only <show name=\"name\"></show>; add refresh=\"2s\" to rerun a command card every 2 seconds while it is on screen (a usage with a \"Refresh: every 2s\" line does so already). Give a card an id, <show name=\"name\" id=\"tests\">JSON</show>, and a later <show> with the same id updates that card in place instead of adding a new one (for progress you keep up to date). Cards may keep state the user changes (ccb.save); you get it with the user's next message. <component name=\"name\">request</component> asks Maintainer to change one, make a new one, or give you one from the shared library.)\n" + components.catalog(of: own)
        if !others.isEmpty {
            text += "\n(App: Also in the shared library, not yours yet, one line each. To use one, ask Maintainer for it with <component name=\"name\">add it to my list</component>; you then get its usage.)\n" + components.summaries(of: others)
        }
        return text
    }

    /// A bot from before 1.9 (or a new one) has no list yet: it gets the built-ins plus every
    /// component it has used, by `component-usage.json` and the cards drawn in its chat. Once.
    func giveFirstComponents(to bot: Bot) {
        guard bot.componentList == nil else { return }
        var used = Set(ComponentLibrary.builtIns)
        for (name, entry) in ComponentUsage.load(from: componentUsage.url).components where (entry.byBot[bot.name] ?? 0) > 0 {
            used.insert(name)
        }
        for message in bot.messages {
            used.formUnion(message.shown.map(\.name))
        }
        bot.setComponentList(components.names.filter(used.contains))
    }

    /// Puts a library component on `bot`'s list. False when it is not in the library, the bot
    /// keeps no list, or its list is full.
    @discardableResult
    public func giveComponent(_ name: String, to bot: Bot) -> Bool {
        guard let list = bot.componentList, components.names.contains(name) else { return false }
        let own = ownComponents(of: bot)
        if own.contains(name) { return true }
        guard own.count < ComponentLibrary.limit else { return false }
        bot.setComponentList(list + [name])
        return true
    }

    /// Takes a component off `bot`'s list; the library copy stays. False when it was not on it.
    @discardableResult
    public func takeComponent(_ name: String, from bot: Bot) -> Bool {
        guard let list = bot.componentList, list.contains(name) else { return false }
        bot.setComponentList(list.filter { $0 != name })
        return true
    }

    /// The bot a tag names: the main bot, a project's manager, a bot of its own or Maintainer.
    func componentHolder(named name: String) -> Bot? {
        let wanted = name.trimmingCharacters(in: .whitespaces).lowercased()
        if wanted == mainBot.name.lowercased() || wanted == "main bot" { return mainBot }
        return everyProject.first { $0.name.lowercased() == wanted }.flatMap { managers[$0.id] }
    }

    /// What Maintainer is told about the bot that asked for `name`, after giving it at once
    /// when the library already has it. Empty when no bot with a list asked.
    /// The bot hears back either way (`ComponentAsk`): at once when the app gave it, else once
    /// Maintainer gives, builds or changes it, or answers without doing so.
    func componentAskNote(_ name: String, request: String, exists: Bool, from bot: Bot?) -> String {
        guard let bot, bot.componentList != nil else { return "" }
        let own = ownComponents(of: bot)
        let limit = ComponentLibrary.limit
        // What the user had asked the bot for, which the component is to answer.
        let userAsked = bot.messages.last { $0.role == .user || $0.role == .relay }.map { Self.shortened($0.text, to: 300) } ?? ""
        var ask = ComponentAsk(name: name, botID: bot.id, request: request, userAsked: userAsked, stamp: components.stamp(of: name), changing: exists && own.contains(name))
        let answerBack = " If you will not or cannot do it, say why and end your reply with <component-declined id=\"\(ask.key)\">why, in one sentence for \(bot.name)</component-declined>; the app passes it on to \(bot.name)."
        let full = " (App: \(bot.name) already has \(own.count) / \(limit) components. Add or build nothing for it: with a choices block of its components, ask the user which one to remove from \(bot.name)'s list first, then <take-component bot=\"\(bot.name)\">that name</take-component>.)"
        if exists, !own.contains(name) {
            guard giveComponent(name, to: bot) else {
                componentAsks.append(ask)
                return full
            }
            ask.changing = false
            componentArrived(name, for: ask, to: bot, by: nil)
            return " (App: \"\(name)\" is already in the library, so the app added it to \(bot.name)'s list and told \(bot.name); nothing to build. Change it only if the request asks for a change.)"
        }
        componentAsks.removeAll { $0.botID == bot.id && $0.name == name }
        componentAsks.append(ask)
        if exists { return " (App: \(bot.name) asked for this change.\(answerBack))" }
        guard own.count < limit else { return full }
        return " (App: \(bot.name) has \(own.count) / \(limit) components. Check the library first: if a component there already does this, build nothing and reply with <give-component bot=\"\(bot.name)\">its name</give-component>. Otherwise build it; once it is in the library the app adds it to \(bot.name)'s list.\(answerBack))"
    }

    /// Components bots asked for that are now in the library go on their lists, and each bot
    /// hears it.
    func deliverAskedComponents() {
        for ask in componentAsks where !ask.changing && components.names.contains(ask.name) {
            guard let bot = botsWithComponents.first(where: { $0.id == ask.botID }) else {
                componentAsks.removeAll { $0 == ask }
                continue
            }
            // Full: Maintainer is asking the user what to drop; it arrives after the take.
            guard giveComponent(ask.name, to: bot) else { continue }
            componentAsks.removeAll { $0 == ask }
            componentArrived(ask.name, for: ask, to: bot, by: "Maintainer")
        }
    }

    /// How the note to a bot whose component arrived (or was changed) starts.
    nonisolated static func arrivalLead(_ name: String, changed: Bool) -> String {
        "(App: Maintainer " + (changed ? "changed the component \"\(name)\" as you asked" : "added the component \"\(name)\" to your list")
    }

    /// `bot` asked (`ask`) and now has `name` on its list (`by` Maintainer, or nil: the app gave
    /// it from the library at once). The bot is woken to answer what the user wanted with it; the
    /// user sees a line about it in that chat.
    func componentArrived(_ name: String, for ask: ComponentAsk, to bot: Bot, by maker: String?, changed: Bool = false) {
        let title = components.shortTitle(of: name).map { "\($0) (\(name))" } ?? name
        let instead = ask.name == name ? "" : " in place of the \"\(ask.name)\" you asked for"
        let request = ask.request.isEmpty ? "" : " (your request: \(Self.shortened(ask.request, to: 200)))"
        let user = ask.userAsked.isEmpty ? "" : " The user had asked you: \"\(ask.userAsked)\"."
        let usage = components.catalog(of: [name])
        bot.queueNote("(App: Here are your components now.)\n" + componentBriefing(for: bot))
        bot.appMessage(Self.arrivalLead(name, changed: changed) + "\(instead)\(request).\(user) Answer that now: draw it with <show name=\"\(name)\">…</show> as its usage says, with one short sentence in the user's language. Do not ask Maintainer for it again.)\n\(usage)")
        tell(bot, changed
            ? L("{0} changed {1} as {2} asked.", maker ?? "Maintainer", title, bot.name)
            : L("{0} added {1} to your components.", maker ?? "Maintainer", title), sourceID: Self.maintainerID)
    }

    /// Maintainer replied: a change a bot asked for that has landed in the library (its files
    /// changed since the request) goes back to that bot. Only once its background work is done
    /// and not while it asks the user something. Nothing else closes a request: Maintainer
    /// declines one by its id (`declineComponentAsk`), and a new one arrives by itself.
    func settleComponentAsks(after reply: ChatMessage) {
        guard reply.role == .bot || reply.role == .error, !reply.isOpenQuestion,
              !maintainer.trace.subagents.contains(where: \.isRunning) else { return }
        // A component it just committed may not have been seen yet.
        components.rescan()
        for ask in componentAsks where ask.changing && components.stamp(of: ask.name) != ask.stamp {
            componentAsks.removeAll { $0 == ask }
            guard let bot = botsWithComponents.first(where: { $0.id == ask.botID }) else { continue }
            componentArrived(ask.name, for: ask, to: bot, by: "Maintainer", changed: true)
        }
    }

    /// Maintainer's `<component-declined id="…">why</component-declined>`: the request with that
    /// id goes back to the bot that asked, with why, so the bot tells the user instead of waiting.
    func declineComponentAsk(_ id: String, reason: String) {
        let id = id.trimmingCharacters(in: .whitespaces).lowercased()
        guard let ask = componentAsks.first(where: { $0.key == id }) else { return }
        componentAsks.removeAll { $0 == ask }
        guard let bot = botsWithComponents.first(where: { $0.id == ask.botID }) else { return }
        let reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        let said = reason.isEmpty ? "" : " Maintainer said: \"\(Self.shortened(reason, to: 500))\"."
        let user = ask.userAsked.isEmpty ? "" : " The user had asked you: \"\(ask.userAsked)\"."
        bot.appMessage("(App: Maintainer did not add the component \"\(ask.name)\" you asked for\(ask.changing ? " (or change it)" : "").\(said)\(user) Tell the user in one or two sentences, in their language, that it is not available and why, then answer their request as well as you can without it. Do not ask Maintainer for it again.)")
        tell(bot, (ask.changing ? L("Maintainer did not change {0}:", ask.name) : L("Maintainer did not add {0}:", ask.name)) + (reason.isEmpty ? "" : " " + Self.shortened(Self.firstLine(of: reason), to: 160)), sourceID: Self.maintainerID)
    }

    static func shortened(_ text: String, to limit: Int) -> String {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.count > limit ? String(text.prefix(limit)) + "…" : text
    }

    /// Maintainer's `<give-component>` / `<take-component>`.
    func changeComponentList(give: Bool, name: String, bot botName: String) {
        guard let bot = componentHolder(named: botName) else {
            maintainer.queueNote("(App: There is no bot called \"\(botName)\"; no component list changed.)")
            return
        }
        let name = components.names.first { $0.lowercased() == name.lowercased() } ?? name
        if give {
            guard components.names.contains(name) else {
                maintainer.queueNote("(App: \"\(name)\" is not in the library, so it was not added to \(bot.name)'s list.)")
                return
            }
            guard giveComponent(name, to: bot) else {
                maintainer.queueNote("(App: \(bot.name) already has \(ownComponents(of: bot).count) / \(ComponentLibrary.limit) components, so \"\(name)\" was not added. Ask the user which one to remove from \(bot.name)'s list first.)")
                return
            }
            // Its answer to a bot's request (maybe a component in place of the one asked for).
            let asked = componentAsks.first { $0.botID == bot.id && $0.name == name }
                ?? componentAsks.first { $0.botID == bot.id && !$0.changing }
            if let asked {
                componentAsks.removeAll { $0 == asked }
                componentArrived(name, for: asked, to: bot, by: "Maintainer")
            } else {
                bot.queueNote("(App: Maintainer gave you the component \"\(name)\"; here are your components now.)\n" + componentBriefing(for: bot))
            }
        } else if takeComponent(name, from: bot) {
            bot.queueNote("(App: \"\(name)\" was taken off your components; it stays in the shared library.)\n" + componentBriefing(for: bot))
            // Room now for one it asked for while its list was full.
            deliverAskedComponents()
        }
    }

    /// The usage card's delete button answers "刪除組件：name": the component comes off the list
    /// of the bot whose card it is; the library copy stays (deleting it there is Maintainer's).
    static func componentToDrop(in text: String) -> String? {
        for prefix in ["刪除組件：", "刪除組件:"] where text.hasPrefix(prefix) {
            let name = text.dropFirst(prefix.count).trimmingCharacters(in: .whitespacesAndNewlines)
            return name.isEmpty ? nil : name
        }
        return nil
    }

    func dropComponent(_ name: String, shownIn message: ChatMessage, in chat: Bot) {
        let owner = message.role == .bot ? (message.sourceID.flatMap(member) ?? chat) : chat
        if takeComponent(name, from: owner) {
            tell(chat, L("Took \"{0}\" off {1}'s components. The shared library keeps it; to delete it from there, ask Maintainer.", name, owner.name))
            owner.queueNote("(App: The user took \"\(name)\" off your components; it stays in the shared library.)\n" + componentBriefing(for: owner))
        } else {
            tell(chat, L("\"{0}\" is not on {1}'s components; nothing changed.", name, owner.name))
        }
    }
}

/// A bot's `<component>` request Maintainer has not answered yet: which component, what the bot
/// asked, and what the user had asked the bot, so the bot can answer the user once it arrives.
struct ComponentAsk: Equatable {
    let id = UUID()
    let name: String
    let botID: UUID
    let request: String
    let userAsked: String
    /// When the component last changed as it was asked for (to see whether a change was made).
    let stamp: [Date?]
    /// A change to a component the bot already has, not one to add to its list.
    var changing: Bool

    /// The id Maintainer answers it by (`<component-declined id="…">`).
    var key: String { String(id.uuidString.prefix(8)).lowercased() }
}
