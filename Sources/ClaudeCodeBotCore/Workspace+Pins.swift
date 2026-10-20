import Foundation

/// Components pinned to a bot: kept on it (chips above the input box, its Board) and drawn again
/// by their command. A pin's command runs in the bot's folder and only once the user has allowed
/// it there, the same rule as a component card in the chat (`ComponentCommands`): pinning never
/// allows a command, and the timer never runs one that is not allowed.
extension Workspace {
    /// Every chat that can have pins: the main bot, each project's bot, the group chats.
    var chatsWithPins: [Bot] {
        [mainBot] + everyProject.compactMap { managers[$0.id] } + Array(groupChats.values)
    }

    /// Where a bot's pinned commands run: its own project folder.
    public func pinFolder(for bot: Bot) -> URL { bot.profile.workingDirectory }

    /// What drawing a chat's pins needs.
    public func pinContext(for bot: Bot, board: Bool = false) -> ChatPayload.PinContext {
        ChatPayload.PinContext(runs: componentCommands, folder: pinFolder(for: bot), board: board, library: components)
    }

    /// Pins the `index`th component of a message, with what it shows now (its command's last
    /// output, or the data it was written with). Nil if there is nothing to pin, or it is pinned
    /// already. `id` is the page's, so its Undo can take it back.
    @discardableResult
    public func pin(messageID: UUID, index: Int, in bot: Bot, id: UUID = UUID(), refresh: PinnedComponent.Refresh = .shown, minutes: Int = PinnedComponent.defaultMinutes) -> PinnedComponent? {
        guard let message = bot.messages.first(where: { $0.id == messageID }),
              message.shown.indices.contains(index) else { return nil }
        let instance = message.shown[index]
        guard components.names.contains(instance.name) else { return nil }
        let command = ChatPayload.command(of: instance, in: message, library: components)
        var data = instance.data
        var ranAt: Date?
        if let command {
            let state = componentCommands.state(for: "\(message.id.uuidString)/\(index)", command: command, in: commandFolder(for: message, in: bot))
            if let output = state.data {
                data = output
                ranAt = state.ranAt
            }
        } else if data == "null" {
            return nil
        }
        let pin = PinnedComponent(id: id, name: instance.name, command: command, data: data, ranAt: ranAt, refresh: refresh, minutes: minutes, size: .preferred(among: components.sizes(of: instance.name)))
        var added = false
        bot.editPins { added = Pins.add(pin, to: &$0) }
        return added ? pin : nil
    }

    /// Pins a component from the picker: the last one this bot drew, or, never drawn here, one
    /// whose about.md gives a Command (it has no data until that runs).
    @discardableResult
    public func pin(named name: String, in bot: Bot, id: UUID = UUID(), refresh: PinnedComponent.Refresh = .shown, minutes: Int = PinnedComponent.defaultMinutes) -> PinnedComponent? {
        if let use = lastUse(of: name, in: bot) {
            return pin(messageID: use.message, index: use.index, in: bot, id: id, refresh: refresh, minutes: minutes)
        }
        guard components.names.contains(name), let command = components.command(of: name) else { return nil }
        let pin = PinnedComponent(id: id, name: name, command: command, data: "null", refresh: refresh, minutes: minutes, size: .preferred(among: components.sizes(of: name)))
        var added = false
        bot.editPins { added = Pins.add(pin, to: &$0) }
        return added ? pin : nil
    }

    /// The newest message of this bot's that shows `name`, and where in it.
    func lastUse(of name: String, in bot: Bot) -> (message: UUID, index: Int)? {
        for message in bot.messages.reversed() where message.role == .bot {
            if let index = message.shown.lastIndex(where: { $0.name == name }) { return (message.id, index) }
        }
        return nil
    }

    public func unpin(_ id: UUID, in bot: Bot) {
        bot.editPins { $0.removeAll { $0.id == id } }
    }

    public func movePin(_ id: UUID, to index: Int, in bot: Bot) {
        bot.editPins { Pins.move(id, to: index, in: &$0) }
    }

    public func resizePin(_ id: UUID, to size: PinnedComponent.Size, in bot: Bot) {
        bot.editPins { pins in
            if let at = pins.firstIndex(where: { $0.id == id }) { pins[at].size = size }
        }
    }

    public func setPinRefresh(_ id: UUID, to refresh: PinnedComponent.Refresh, minutes: Int? = nil, in bot: Bot) {
        bot.editPins { pins in
            guard let at = pins.firstIndex(where: { $0.id == id }), pins[at].command != nil else { return }
            pins[at].refresh = refresh
            if let minutes { pins[at].minutes = max(PinnedComponent.minimumMinutes, minutes) }
        }
    }

    /// A pinned card's command: `approve` is the user allowing it (it needs the command and
    /// folder the card showed, as in the chat); `force` runs it again (↻). Nothing that is not
    /// allowed runs. What it prints is kept on the pin.
    public func runPin(_ id: UUID, in bot: Bot, command shown: String? = nil, folder shownFolder: String? = nil, detail shownDetail: String? = nil, approve: Bool = false, force: Bool = false) async {
        guard let pin = bot.pins.first(where: { $0.id == id }), let command = pin.command else { return }
        let folder = pinFolder(for: bot)
        if approve, shown == nil || shownFolder == nil { return }
        if let shown, shown != command { return }
        if let shownFolder, URL(filePath: shownFolder).standardizedFileURL.path != folder.standardizedFileURL.path { return }
        if approve {
            guard approveCard(command, detail: components.detailCommand(of: pin.name), shownDetail: shownDetail, in: folder) else { return }
        }
        guard componentCommands.isApproved(command, in: folder) else { return }
        await componentCommands.run(card: pin.card, command: command, in: folder, force: force)
        keepOutput(of: pin, in: bot)
    }

    /// A finished run's output, saved on the pin so it shows after a restart too.
    private func keepOutput(of pin: PinnedComponent, in bot: Bot) {
        guard let state = componentCommands.runs[pin.card], state.status == .done, let data = state.data else { return }
        bot.editPins { pins in
            guard let at = pins.firstIndex(where: { $0.id == pin.id }), pins[at].command == pin.command else { return }
            pins[at].data = data
            pins[at].ranAt = state.ranAt
        }
    }

    /// When a pin's command last ran (this run of the app, else as saved).
    func lastRan(_ pin: PinnedComponent) -> Date? {
        componentCommands.runs[pin.card]?.ranAt ?? pin.ranAt
    }

    /// Pins just shown (a chip opened, or the Board; nil: all of them): those refreshed "when
    /// shown" run again, if allowed and not run in the last `Pins.shownCooldown` seconds.
    public func pinsShown(_ ids: [UUID]? = nil, in bot: Bot, now: Date = Date()) async {
        let folder = pinFolder(for: bot)
        let due = bot.pins.filter { pin in
            guard pin.refresh == .shown, let command = pin.command, ids?.contains(pin.id) ?? true,
                  componentCommands.isApproved(command, in: folder) else { return false }
            guard let last = lastRan(pin) else { return true }
            return now.timeIntervalSince(last) >= Pins.shownCooldown
        }
        await run(due, in: bot)
    }

    /// Pins refreshed every few minutes whose time has come, in every chat. Only commands the
    /// user allowed in that bot's folder run.
    public func refreshDuePins(now: Date = Date()) async {
        await withTaskGroup(of: Void.self) { group in
            for bot in chatsWithPins {
                let folder = pinFolder(for: bot)
                let due = bot.pins.filter { pin in
                    guard let command = pin.command, componentCommands.isApproved(command, in: folder) else { return false }
                    return pin.isDue(at: now, lastRan: lastRan(pin))
                }
                if !due.isEmpty { group.addTask { await self.run(due, in: bot) } }
            }
        }
    }

    private func run(_ pins: [PinnedComponent], in bot: Bot) async {
        await withTaskGroup(of: Void.self) { group in
            for pin in pins {
                group.addTask { await self.runPin(pin.id, in: bot, force: true) }
            }
        }
    }

    /// Checks every `interval` seconds for pins due a refresh (the app starts it).
    public func startPinRefresh(every interval: TimeInterval = 30) {
        Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshDuePins()
                try? await Task.sleep(for: .seconds(interval))
            }
        }
    }
}
