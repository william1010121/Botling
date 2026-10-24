import Foundation

/// "Report a problem…" in a component card's ⋯ menu (a reply's card, an opened pin, a Board tile
/// or a floating card): what the user says is wrong goes to Maintainer by the same road as a bot's
/// `<component name="…">request</component>` (`requestComponentChange`), with what Maintainer
/// needs to find it: whose chat the card is in, how it refreshes, when its data is from, and
/// where the screenshot of the card is kept.
extension Workspace {
    /// Sends the user's report about `name`'s card in `bot`'s chat (the pin `pinID`, else `bot`'s
    /// pin of that component, if any). `screenshot` (the card as it looked) is kept in `bot`'s
    /// attachments and named in the request; `pictures` pasted or dropped on the box go along.
    /// Without words or a picture of the user's own nothing is sent (a screenshot alone says
    /// nothing). Returns whether it was sent.
    @discardableResult
    public func reportComponentProblem(_ name: String, text: String, in bot: Bot, pinID: UUID? = nil, screenshot: URL? = nil, pictures: [URL] = []) -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !pictures.isEmpty else { return false }
        let pin = bot.pins.first { $0.id == pinID } ?? bot.pins.first { $0.name == name }
        let kept = screenshot.flatMap(bot.keep)?.url
        let said = text.isEmpty ? "see the attached picture\(pictures.count == 1 ? "" : "s")" : text
        requestComponentChange(name, request: Self.problemReport(said, chat: bot.name, pin: pin, screenshot: kept), from: "The user", files: (kept.map { [$0] } ?? []) + pictures)
        return true
    }

    /// The request a problem report makes: where it came from, the user's words, then the card's
    /// refresh, when its data is from and its screenshot, when there are any.
    static func problemReport(_ text: String, chat: String, pin: PinnedComponent?, screenshot: URL?) -> String {
        var card: [String] = []
        if let pin {
            card.append(refreshWords(of: pin))
            if let when = pin.ranAt ?? pin.savedAt { card.append("data from \(Self.reportStamp(when))") }
        }
        var notes: [String] = []
        if !card.isEmpty { notes.append("Card: " + card.joined(separator: "; ") + ".") }
        if let screenshot { notes.append("Screenshot of the card: \(screenshot.path)") }
        let base = "Problem reported from the card in \(chat)'s chat: \(text)"
        return notes.isEmpty ? base : "\(base) (\(notes.joined(separator: " ")))"
    }

    /// How a pin refreshes, as Maintainer is told it.
    private static func refreshWords(of pin: PinnedComponent) -> String {
        guard pin.command != nil else { return "no command; keeps the data it was drawn with" }
        switch pin.refresh {
        case .shown: return "refreshes when shown"
        case .manual: return "refreshes only on ↻"
        case .interval: return pin.seconds.map { "refreshes every \($0) sec" } ?? "refreshes every \(pin.minutes) min"
        }
    }

    /// "2026-10-24 18:54:12", in the user's time zone.
    private static func reportStamp(_ date: Date) -> String {
        date.formatted(.verbatim("\(year: .defaultDigits)-\(month: .twoDigits)-\(day: .twoDigits) \(hour: .twoDigits(clock: .twentyFourHour, hourCycle: .zeroBased)):\(minute: .twoDigits):\(second: .twoDigits)", timeZone: .current, calendar: .current))
    }
}
