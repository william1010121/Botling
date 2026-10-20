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
        var text = "(App: Components in the chat: \(own.count) / \(limit) yours, each with its usage below (a bot has at most \(limit)). <show name=\"name\">JSON</show> draws one; <show name=\"name\" command=\"git diff --stat\"></show> fills it with what that command prints instead (run in your project folder once the user allows it; JSON output is used as the data, other output as one string; the card has a refresh button). A component whose usage has a \"Command:\" line needs only <show name=\"name\"></show>. <component name=\"name\">request</component> asks Maintainer to change one, make a new one, or give you one from the shared library.)\n" + components.catalog(of: own)
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
    func componentAskNote(_ name: String, exists: Bool, from bot: Bot?) -> String {
        guard let bot, bot.componentList != nil else { return "" }
        let own = ownComponents(of: bot)
        let limit = ComponentLibrary.limit
        let full = " (App: \(bot.name) already has \(own.count) / \(limit) components. Add or build nothing for it: with a choices block of its components, ask the user which one to remove from \(bot.name)'s list first, then <take-component bot=\"\(bot.name)\">that name</take-component>.)"
        if exists {
            guard !own.contains(name) else { return "" }
            return giveComponent(name, to: bot)
                ? " (App: \"\(name)\" is already in the library, so the app added it to \(bot.name)'s list; nothing to build. Change it only if the request asks for a change.)"
                : full
        }
        guard own.count < limit else { return full }
        componentAsks[name, default: []].insert(bot.id)
        return " (App: \(bot.name) has \(own.count) / \(limit) components. Check the library first: if a component there already does this, build nothing and reply with <give-component bot=\"\(bot.name)\">its name</give-component>. Otherwise build it; once it is in the library the app adds it to \(bot.name)'s list.)"
    }

    /// Components bots asked for that are now in the library go on their lists.
    func deliverAskedComponents() {
        for (name, ids) in componentAsks where components.names.contains(name) {
            componentAsks[name] = nil
            for bot in botsWithComponents where ids.contains(bot.id) {
                giveComponent(name, to: bot)
            }
        }
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
            bot.queueNote("(App: Maintainer gave you the component \"\(name)\"; here are your components now.)\n" + componentBriefing(for: bot))
        } else if takeComponent(name, from: bot) {
            bot.queueNote("(App: \"\(name)\" was taken off your components; it stays in the shared library.)\n" + componentBriefing(for: bot))
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
            tell(chat, "Took \"\(name)\" off \(owner.name)'s components. The shared library keeps it; to delete it from there, ask Maintainer.")
            owner.queueNote("(App: The user took \"\(name)\" off your components; it stays in the shared library.)\n" + componentBriefing(for: owner))
        } else {
            tell(chat, "\"\(name)\" is not on \(owner.name)'s components; nothing changed.")
        }
    }
}
