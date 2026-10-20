import Foundation
import Testing
@testable import ClaudeCodeBotCore

/// The subscription's 5-hour and weekly limits, read from `rate_limit_event` lines and kept.
@MainActor
struct RateLimitTests {
    let root = FileManager.default.temporaryDirectory.appending(path: "ccb-limits-\(UUID().uuidString)")
    let seen = Date(timeIntervalSince1970: 1_792_400_000)

    func makeWorkspace(_ fake: FakeLauncher) -> Workspace {
        Workspace(root: root.appending(path: "ccb"), launcher: fake.launcher) { profile, store in
            Bot(profile: profile, launcher: fake.launcher, store: store)
        }
    }

    func parse(_ line: String) -> RateLimits? {
        let object = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] ?? [:]
        return RateLimits.parse(object, seen: seen)
    }

    // The shape `claude` 2.x writes (seen in real stream-json output).
    let unified = #"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1792450800,"rateLimitType":"seven_day","utilization":0.76,"overageStatus":"rejected","isUsingOverage":false,"surpassedThreshold":0.75,"unifiedWindows":{"five_hour":{"utilization":0.47,"resetsAt":1792418400},"seven_day":{"utilization":0.76,"resetsAt":1792450800}}},"uuid":"u","session_id":"s"}"#

    @Test func bothWindowsComeFromUnifiedWindows() throws {
        let limits = try #require(parse(unified))
        #expect(limits.fiveHour == RateLimitWindow(used: 0.47, resetsAt: Date(timeIntervalSince1970: 1_792_418_400), seen: seen))
        #expect(limits.week == RateLimitWindow(used: 0.76, resetsAt: Date(timeIntervalSince1970: 1_792_450_800), seen: seen))
    }

    @Test func theStreamTurnsItIntoAnEvent() throws {
        let events = StreamEvent.events(in: unified)
        guard case let .rateLimits(limits)? = events.first, events.count == 1 else { Issue.record("no event: \(events)"); return }
        #expect(limits.fiveHour?.used == 0.47 && limits.week?.used == 0.76)
    }

    @Test func anOlderLineNamesOneWindow() throws {
        let line = #"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1792418400,"rateLimitType":"five_hour","utilization":0.3}}"#
        let limits = try #require(parse(line))
        #expect(limits.fiveHour?.used == 0.3 && limits.week == nil)
    }

    @Test func aRejectionWithoutUtilizationMeansUsedUp() throws {
        let line = #"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1792418400,"rateLimitType":"five_hour","overageStatus":"rejected"}}"#
        #expect(try #require(parse(line)).fiveHour?.used == 1)
    }

    @Test func aLineWithoutNumbersSaysNothing() {
        let line = #"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1792418400,"rateLimitType":"five_hour"}}"#
        #expect(parse(line) == nil)
        #expect(StreamEvent.events(in: line).isEmpty)
        #expect(parse(#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"seven_day_opus","utilization":0.2}}"#) == nil)
    }

    @Test func aNewReadingReplacesOnlyTheWindowsItHas() {
        var limits = RateLimits(fiveHour: RateLimitWindow(used: 0.1, resetsAt: nil, seen: seen),
                                week: RateLimitWindow(used: 0.5, resetsAt: nil, seen: seen))
        limits.merge(RateLimits(fiveHour: RateLimitWindow(used: 0.2, resetsAt: nil, seen: seen + 60)))
        #expect(limits.fiveHour?.used == 0.2 && limits.week?.used == 0.5)
    }

    @Test func oldReadingsSaySoAndResetWindowsShowNoNumber() {
        let window = RateLimitWindow(used: 0.42, resetsAt: seen + 2 * 3600 + 13 * 60, seen: seen)
        let limits = RateLimits(fiveHour: window)
        #expect(limits.staleSince(now: seen + 5 * 60) == nil)
        #expect(limits.staleSince(now: seen + 25 * 60) == seen)
        #expect(RateLimitText.asOf(seen, now: seen + 25 * 60) == "as of 25 min ago")
        #expect(RateLimitText.asOf(seen, now: seen + 3 * 3600) == "as of 3 h ago")
        #expect(RateLimitText.percent(window, now: seen) == "42%")
        #expect(RateLimitText.countdown(window, now: seen) == "in 2h 13m")
        #expect(RateLimitText.countdown(window, now: seen + 2 * 3600 + 5 * 60) == "in 8m")
        let after = seen + 3 * 3600
        #expect(window.hasReset(at: after))
        #expect(RateLimitText.percent(window, now: after) == "–")
        #expect(RateLimitText.countdown(window, now: after) == "reset")
    }

    @Test func theWeekShowsTheDayItStartsOver() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        // Tue 2026-10-20 12:00 UTC; resets Thu 09:00.
        let now = calendar.date(from: DateComponents(year: 2026, month: 10, day: 20, hour: 12))!
        let reset = calendar.date(from: DateComponents(year: 2026, month: 10, day: 22, hour: 9))!
        let window = RateLimitWindow(used: 0.67, resetsAt: reset, seen: now)
        #expect(RateLimitText.resetDay(window, now: now, calendar: calendar, locale: Locale(identifier: "en_US"))
            .replacingOccurrences(of: "\u{202F}", with: " ") == "Thu 9:00 AM")
    }

    @Test func aBotsReadingIsKeptAcrossRestarts() async {
        let fake = FakeLauncher()
        fake.respond = { _ in nil }
        let workspace = makeWorkspace(fake)
        #expect(workspace.rateLimits.isEmpty)
        workspace.mainBot.send("hello")
        await eventually { fake.agents.count == 1 }
        let reading = RateLimits(fiveHour: RateLimitWindow(used: 0.47, resetsAt: seen, seen: seen),
                                 week: RateLimitWindow(used: 0.76, resetsAt: seen + 86400, seen: seen))
        fake.agents[0].emit(.rateLimits(reading))
        await eventually { !workspace.rateLimits.isEmpty }
        #expect(workspace.rateLimits == reading)

        let later = makeWorkspace(FakeLauncher())
        #expect(later.rateLimits == reading)
    }
}
