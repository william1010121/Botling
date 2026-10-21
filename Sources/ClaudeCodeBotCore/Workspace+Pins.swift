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
        ChatPayload.PinContext(runs: componentCommands, folder: pinFolder(for: bot), board: board, library: components, floating: floatingPins(in: bot).count)
    }

    // MARK: Floating in a corner

    /// A chat's id that stays the same across launches (`Bot.id` does not): the main bot's
    /// fixed id, a project's or bot's, a group's. Nil for a chat that cannot hold pins.
    public func pinChatID(of bot: Bot) -> UUID? {
        if bot === mainBot { return Self.mainBotID }
        if let id = managers.first(where: { $0.value === bot })?.key { return id }
        return groupChats.first { $0.value === bot }?.key
    }

    /// The chat `pinChatID(of:)` names, if it is still there.
    public func pinChat(_ id: UUID) -> Bot? {
        id == Self.mainBotID ? mainBot : managers[id] ?? groupChats[id]
    }

    /// Floating pins shown over every bot's chat, in the order they were made so: only those
    /// whose chat and pin are still there and still float.
    public var globalFloats: [GlobalFloat] {
        var seen = Set<UUID>()
        return (settings.globalFloats ?? []).filter { ref in
            guard let bot = pinChat(ref.botID), bot.pins.contains(where: { $0.id == ref.pinID && $0.float != nil }) else { return false }
            return seen.insert(ref.pinID).inserted
        }
    }

    /// Whether a floating pin shows in all bots' chats.
    public func isGlobalFloat(_ id: UUID) -> Bool {
        globalFloats.contains { $0.pinID == id }
    }

    /// Forgets global floats whose chat or pin is gone, or that stopped floating.
    func dropStaleGlobalFloats() {
        guard let saved = settings.globalFloats, saved != globalFloats else { return }
        settings.globalFloats = globalFloats.isEmpty ? nil : globalFloats
        settings.save(to: settingsURL)
    }

    /// The floating pins of every bot (shown in its chat or in all), in the order of the bots
    /// and their pins.
    public func floatingPins() -> [(bot: Bot, pin: PinnedComponent)] {
        chatsWithPins.flatMap { bot in bot.pins.filter { $0.float != nil }.map { (bot: bot, pin: $0) } }
    }

    /// The floating cards a chat would show with no limit: other bots' shown in all bots (in
    /// the order they were made so), then its own (global ones among them, in that order too).
    private func wantedFloats(in chat: Bot) -> (global: [(bot: Bot, pin: PinnedComponent)], own: [PinnedComponent]) {
        let global = globalFloats.compactMap { ref -> (bot: Bot, pin: PinnedComponent)? in
            guard let bot = pinChat(ref.botID), let pin = bot.pins.first(where: { $0.id == ref.pinID }) else { return nil }
            return (bot, pin)
        }
        let own = chat.pins.filter { $0.float != nil }
        return (global, own)
    }

    /// The floating cards a chat shows, in the order they stack from their corner: those shown
    /// in all bots first (the same place in every chat), then the chat's own. At most
    /// `Pins.maxFloating`: the chat's own always show, other bots' fill what room is left.
    public func floatingPins(in chat: Bot) -> [(bot: Bot, pin: PinnedComponent, global: Bool)] {
        let (global, own) = wantedFloats(in: chat)
        let ownIDs = Set(own.map(\.id))
        var room = max(0, Pins.maxFloating - own.count)
        var shown: [(bot: Bot, pin: PinnedComponent, global: Bool)] = []
        for entry in global {
            if ownIDs.contains(entry.pin.id) {
                shown.append((entry.bot, entry.pin, true))
            } else if room > 0 {
                room -= 1
                shown.append((entry.bot, entry.pin, true))
            }
        }
        let globalIDs = Set(global.map(\.pin.id))
        shown += own.filter { !globalIDs.contains($0.id) }.map { (bot: chat, pin: $0, global: false) }
        return shown
    }

    /// Why a floating pin of `bot` cannot be shown in all bots: the first other chat that shows
    /// `Pins.maxFloating` cards already. Nil: it can (or already is).
    public func globalFloatBlocked(_ id: UUID, in bot: Bot) -> String? {
        guard !isGlobalFloat(id) else { return nil }
        for chat in chatsWithPins + [codexBot] where chat !== bot {
            let (global, own) = wantedFloats(in: chat)
            let ownIDs = Set(own.map(\.id))
            let count = own.count + global.filter { !ownIDs.contains($0.pin.id) }.count
            if count + 1 > Pins.maxFloating { return chat.name }
        }
        return nil
    }

    /// The floating cards a chat's page draws: its own, and other bots' shown in all bots.
    public func floatingPinViews(in chat: Bot) -> [ChatPayload.FloatingPin] {
        floatingPins(in: chat).map { entry in
            ChatPayload.FloatingPin(botID: entry.bot.id.uuidString, botName: entry.bot.name, pin: ChatPayload.pin(view: entry.pin, context: pinContext(for: entry.bot)),
                                    global: entry.global, blocked: entry.global ? nil : globalFloatBlocked(entry.pin.id, in: entry.bot))
        }
    }

    /// The bot a pin is on, so a floating card's ↻ and menu reach it from any bot's chat.
    public func bot(holdingPin id: UUID) -> Bot? {
        chatsWithPins.first { $0.pins.contains { $0.id == id } }
    }

    /// Floats a pin in a corner of its bot's chat (at the defaults) or stops it (and so stops it
    /// showing in all bots). Floating one more than `Pins.maxFloating` cards in that chat does
    /// not; returns whether it floats (or stopped) as asked.
    @discardableResult
    public func floatPin(_ id: UUID, _ on: Bool, in bot: Bot) -> Bool {
        guard let pin = bot.pins.first(where: { $0.id == id }) else { return false }
        if on, pin.float == nil, floatingPins(in: bot).count >= Pins.maxFloating { return false }
        objectWillChange.send()
        bot.editPins { pins in
            guard let at = pins.firstIndex(where: { $0.id == id }) else { return }
            pins[at].float = on ? (pins[at].float ?? PinnedComponent.Floating()) : nil
        }
        if !on { dropStaleGlobalFloats() }
        return true
    }

    /// Shows a floating pin over every bot's chat ("Show in all bots"), or only its own again
    /// ("Only in …"). It stays the owning bot's pin: its command runs in that bot's folder, and
    /// where it sits is kept with it. Not when it does not float, or a chat would show more than
    /// `Pins.maxFloating` cards (`globalFloatBlocked`); returns whether it changed as asked.
    @discardableResult
    public func setPinGlobal(_ id: UUID, _ on: Bool, in bot: Bot) -> Bool {
        guard let chatID = pinChatID(of: bot), bot.pins.contains(where: { $0.id == id && $0.float != nil }) else { return false }
        guard on != isGlobalFloat(id) else { return true }
        if on, globalFloatBlocked(id, in: bot) != nil { return false }
        objectWillChange.send()
        let kept = globalFloats.filter { $0.pinID != id }
        let list = on ? kept + [GlobalFloat(botID: chatID, pinID: id)] : kept
        settings.globalFloats = list.isEmpty ? nil : list
        settings.save(to: settingsURL)
        return true
    }

    /// Where a floating pin sits: the corner it was dragged to, its size, folded or not. Nothing
    /// for a pin that does not float.
    public func setPinFloat(_ id: UUID, corner: PinnedComponent.Floating.Corner? = nil, width: Int? = nil, height: Int? = nil, collapsed: Bool? = nil, in bot: Bot) {
        guard bot.pins.contains(where: { $0.id == id && $0.float != nil }) else { return }
        objectWillChange.send()
        bot.editPins { pins in
            guard let at = pins.firstIndex(where: { $0.id == id }), let float = pins[at].float else { return }
            pins[at].float = PinnedComponent.Floating(corner: corner ?? float.corner, width: width ?? float.width, height: height ?? float.height, collapsed: collapsed ?? float.collapsed)
        }
    }

    /// Pins the `index`th component of a message, with what it shows now (its command's last
    /// output, or the data it was written with). Nil if there is nothing to pin, or it is pinned
    /// already. `id` is the page's, so its Undo can take it back.
    @discardableResult
    public func pin(messageID: UUID, index: Int, in bot: Bot, id: UUID = UUID(), refresh: PinnedComponent.Refresh = .shown, minutes: Int = PinnedComponent.defaultMinutes, seconds: Int? = nil) -> PinnedComponent? {
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
        let pin = PinnedComponent(id: id, name: instance.name, command: command, data: data, ranAt: ranAt, refresh: refresh, minutes: minutes, size: .preferred(among: components.sizes(of: instance.name)), seconds: seconds)
        var added = false
        bot.editPins { added = Pins.add(pin, to: &$0) }
        guard added else { return nil }
        makeLive(pin.id, in: bot)
        return pin
    }

    /// Pins a component made from a reply (`ComponentSpec`), as drawn under that reply: the data
    /// the bot that wrote it filled in, or its command's last output. A bot-filled one whose
    /// about.md suggests a `Board command:` is then made live (`makeLive`).
    @discardableResult
    public func pin(spec specID: UUID, in bot: Bot, id: UUID = UUID(), refresh: PinnedComponent.Refresh = .shown, minutes: Int = PinnedComponent.defaultMinutes, seconds: Int? = nil) -> PinnedComponent? {
        guard let (_, spec) = specLocation(specID), let name = spec.built, components.names.contains(name),
              let shown = ChatPayload.specDisplay(spec, library: components, runs: componentCommands) else { return nil }
        let command = ChatPayload.specCommand(spec, component: name, library: components)
        var data = shown.data
        var ranAt: Date?
        if let command {
            let state = componentCommands.state(for: spec.card, command: command, in: URL(filePath: spec.folder))
            if let output = state.data {
                data = output
                ranAt = state.ranAt
            }
        }
        guard command != nil || data != "null" else { return nil }
        let pin = PinnedComponent(id: id, name: name, command: command, data: data, ranAt: ranAt, refresh: refresh, minutes: minutes, size: .preferred(among: components.sizes(of: name)), seconds: seconds)
        var added = false
        bot.editPins { added = Pins.add(pin, to: &$0) }
        guard added else { return nil }
        makeLive(pin.id, in: bot)
        return pin
    }

    // MARK: Live on the Board

    /// A pin a bot filled (no command) of a component whose about.md suggests a `Board command:`:
    /// the same component gets a Command, so it refreshes on the Board. One that already has a
    /// Command takes it now; otherwise Maintainer is asked (once per component) to add it, and
    /// the pin shows the bot's data with "making it live…" until it lands
    /// (`finishBoardCommands`). The Command still runs only once the user allows it on the pin.
    func makeLive(_ id: UUID, in bot: Bot) {
        guard let pin = bot.pins.first(where: { $0.id == id }), pin.command == nil,
              let suggested = components.boardCommand(of: pin.name) else { return }
        if let command = components.command(of: pin.name) {
            goLive(pin.name, command: command, in: bot)
            return
        }
        bot.editPins { pins in
            if let at = pins.firstIndex(where: { $0.id == id }) { pins[at].makingLive = true }
        }
        guard boardCommandAsks.insert(pin.name).inserted else { return }
        let brief = chatsWithPins.lazy.flatMap(\.specs).first { $0.built == pin.name && $0.brief != nil }?.brief
        handToMaintainer(ComponentSpecs.boardCommandRequest(component: pin.name, suggested: suggested, folder: pinFolder(for: bot).path, bot: bot.name, brief: brief))
    }

    /// Pins waiting for their component's Command (`makeLive`) whose Command is in the library
    /// now: they run it from now on (when shown, once allowed), keeping the bot's data until then.
    func finishBoardCommands() {
        for bot in chatsWithPins where bot.pins.contains(where: \.makingLive) {
            for name in Set(bot.pins.filter(\.makingLive).map(\.name)) {
                guard let command = components.command(of: name) else { continue }
                goLive(name, command: command, in: bot)
            }
        }
        boardCommandAsks = boardCommandAsks.filter { components.command(of: $0) == nil }
    }

    private func goLive(_ name: String, command: String, in bot: Bot) {
        bot.editPins { pins in
            for at in pins.indices where pins[at].name == name && pins[at].command == nil {
                pins[at].command = command
                pins[at].makingLive = false
                pins[at].refresh = .shown
            }
        }
    }

    /// Pins a component from the picker: the last one this bot drew, or, never drawn here, one
    /// whose about.md gives a Command (it has no data until that runs).
    @discardableResult
    public func pin(named name: String, in bot: Bot, id: UUID = UUID(), refresh: PinnedComponent.Refresh = .shown, minutes: Int = PinnedComponent.defaultMinutes, seconds: Int? = nil) -> PinnedComponent? {
        if let use = lastUse(of: name, in: bot) {
            return pin(messageID: use.message, index: use.index, in: bot, id: id, refresh: refresh, minutes: minutes, seconds: seconds)
        }
        guard components.names.contains(name), let command = components.command(of: name) else { return nil }
        let pin = PinnedComponent(id: id, name: name, command: command, data: "null", refresh: refresh, minutes: minutes, size: .preferred(among: components.sizes(of: name)), seconds: seconds)
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
        dropStaleGlobalFloats()
    }

    public func movePin(_ id: UUID, to index: Int, in bot: Bot) {
        bot.editPins { Pins.move(id, to: index, in: &$0) }
    }

    public func resizePin(_ id: UUID, to size: PinnedComponent.Size, in bot: Bot) {
        bot.editPins { pins in
            if let at = pins.firstIndex(where: { $0.id == id }) { pins[at].size = size }
        }
    }

    /// Board cards put where the page laid them out, with new sizes (see `Pins.arrange`).
    public func arrangePins(_ places: [(id: UUID, place: PinnedComponent.Place, size: PinnedComponent.Size?)], in bot: Bot) {
        bot.editPins { Pins.arrange(places, in: &$0) }
    }

    /// How tall a pin opens above the input box, as the user dragged its panel (nil: as tall as
    /// its content again). Kept within `PinnedComponent.panelHeights`.
    public func setPinPanelHeight(_ id: UUID, to height: Int?, in bot: Bot) {
        bot.editPins { pins in
            if let at = pins.firstIndex(where: { $0.id == id }) { pins[at].panelHeight = PinnedComponent.clampedPanelHeight(height) }
        }
    }

    /// A pinned component's `ccb.setStatus({text, tone})`: what its chip shows beside its icon,
    /// kept with the pin. Nil text clears it (the chip shows the pin's headline again).
    public func setPinStatus(_ id: UUID, text: String?, tone: String?, in bot: Bot) {
        bot.editPins { pins in
            guard let at = pins.firstIndex(where: { $0.id == id }) else { return }
            pins[at].status = text.map { PinStatus(text: $0, tone: PinStatus.Tone(spelled: tone)) }
        }
    }

    /// How a pin refreshes. With `minutes`, every that many minutes (and `seconds`, when given,
    /// instead: nil goes back to minutes); with `seconds` alone, every that many seconds. Any
    /// interval from 2 seconds to 24 hours (the menu's presets or its custom one) is kept.
    public func setPinRefresh(_ id: UUID, to refresh: PinnedComponent.Refresh, minutes: Int? = nil, seconds: Int? = nil, in bot: Bot) {
        bot.editPins { pins in
            guard let at = pins.firstIndex(where: { $0.id == id }), pins[at].command != nil else { return }
            pins[at].refresh = refresh
            if let minutes {
                pins[at].minutes = PinnedComponent.clampMinutes(minutes)
                pins[at].seconds = seconds.map(PinnedComponent.clampSeconds)
            } else if let seconds {
                pins[at].seconds = PinnedComponent.clampSeconds(seconds)
            }
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
    func keepOutput(of pin: PinnedComponent, in bot: Bot) {
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
                    // A floating pin refreshed every few seconds is rerun by the page that shows
                    // it, only while the window is shown: one shown in all bots, or one of the
                    // chat on screen. One floating only in another chat runs here as any pin.
                    if pin.float != nil, pin.refresh == .interval, pin.seconds != nil,
                       bot === selectedBot || isGlobalFloat(pin.id) { return false }
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

    /// Checks every `interval` seconds for pins due a refresh (the app starts it); every second,
    /// for pins refreshed every few seconds.
    public func startPinRefresh(every interval: TimeInterval = 1) {
        Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshDuePins()
                try? await Task.sleep(for: .seconds(interval))
            }
        }
    }
}
