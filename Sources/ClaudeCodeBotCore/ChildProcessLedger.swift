import Darwin
import Foundation

/// The `claude` processes this app run started, kept in a file. A bot's process (and the commands
/// and subagents it runs in the background) does not die with the app: one that quits, crashes
/// or is replaced by a new build leaves them running, unseen, still working and spending. The
/// next run ends what the file names (`endLeftovers`), and quitting ends its own (`endAll`).
public final class ChildProcessLedger: @unchecked Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public var pid: pid_t
        /// When it started (seconds since 1970, to the microsecond): a pid used again later by
        /// another process does not match.
        public var started: Double
        /// The app run that started it.
        public var app: pid_t

        public init(pid: pid_t, started: Double, app: pid_t) {
            self.pid = pid
            self.started = started
            self.app = app
        }
    }

    /// The app's ledger, set at launch; nil in tests and tools.
    nonisolated(unsafe) public static var shared: ChildProcessLedger?

    let file: URL
    private let lock = NSLock()

    public init(file: URL) {
        self.file = file
    }

    public var entries: [Entry] {
        lock.withLock { load() }
    }

    /// A process this run started.
    public func record(_ pid: pid_t) {
        guard let started = Self.startTime(of: pid) else { return }
        lock.withLock {
            var all = load().filter { $0.pid != pid }
            all.append(Entry(pid: pid, started: started, app: getpid()))
            save(all)
        }
    }

    /// It ended.
    public func forget(_ pid: pid_t) {
        lock.withLock {
            let all = load()
            let kept = all.filter { !($0.pid == pid && $0.app == getpid()) }
            if kept != all { save(kept) }
        }
    }

    /// Ends what earlier app runs that are gone left running, with everything they started.
    /// Entries of a run still going (another copy of the app) stay. Returns the pids ended.
    @discardableResult
    public func endLeftovers(grace: TimeInterval = 2) -> [pid_t] {
        let ended: [Entry] = lock.withLock {
            let all = load()
            let me = getpid()
            let gone = { (entry: Entry) in entry.app != me && !Self.isAlive(entry.app) }
            save(all.filter { !gone($0) })
            // Only the process it wrote down: a pid since given to another one is left alone.
            return all.filter { gone($0) && Self.startTime(of: $0.pid) == $0.started }
        }
        Self.endTrees(ended.map(\.pid), grace: grace)
        return ended.map(\.pid)
    }

    /// The app quits: its own processes go, with all they started (background commands too).
    public func endAll(grace: TimeInterval = 2) {
        let mine: [Entry] = lock.withLock {
            let all = load()
            save(all.filter { $0.app != getpid() })
            return all.filter { $0.app == getpid() }
        }
        Self.endTrees(mine.filter { Self.startTime(of: $0.pid) == $0.started }.map(\.pid), grace: grace)
    }

    // MARK: Processes

    static func isAlive(_ pid: pid_t) -> Bool {
        kill(pid, 0) == 0 || errno == EPERM
    }

    static func info(of pid: pid_t) -> kinfo_proc? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0, info.kp_proc.p_pid == pid else { return nil }
        return info
    }

    /// When `pid` started, or nil when there is no such process.
    public static func startTime(of pid: pid_t) -> Double? {
        guard let info = info(of: pid) else { return nil }
        let time = info.kp_proc.p_un.__p_starttime
        return Double(time.tv_sec) + Double(time.tv_usec) / 1_000_000
    }

    /// Every process as (pid, parent).
    static func table() -> [(pid: pid_t, parent: pid_t)] {
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
        var size = 0
        guard sysctl(&mib, 4, nil, &size, nil, 0) == 0 else { return [] }
        let count = size / MemoryLayout<kinfo_proc>.stride + 16
        var list = [kinfo_proc](repeating: kinfo_proc(), count: count)
        size = count * MemoryLayout<kinfo_proc>.stride
        guard sysctl(&mib, 4, &list, &size, nil, 0) == 0 else { return [] }
        return list.prefix(size / MemoryLayout<kinfo_proc>.stride).map { ($0.kp_proc.p_pid, $0.kp_eproc.e_ppid) }
    }

    /// `roots` and everything under them.
    static func trees(_ roots: [pid_t]) -> [pid_t] {
        let table = table()
        var found = roots
        var index = 0
        while index < found.count {
            let parent = found[index]
            for entry in table where entry.parent == parent && !found.contains(entry.pid) { found.append(entry.pid) }
            index += 1
        }
        return found
    }

    /// SIGTERM to each process of the trees (children first seen before their parent ends and
    /// they move to launchd), then SIGKILL to what is left after `grace`.
    static func endTrees(_ roots: [pid_t], grace: TimeInterval) {
        guard !roots.isEmpty else { return }
        let all = trees(roots)
        let starts = Dictionary(all.map { ($0, startTime(of: $0)) }, uniquingKeysWith: { first, _ in first })
        for pid in all.reversed() { kill(pid, SIGTERM) }
        let deadline = Date().addingTimeInterval(grace)
        while Date() < deadline, all.contains(where: { startTime(of: $0) != nil && startTime(of: $0) == starts[$0] && !isZombie($0) }) {
            usleep(20_000)
        }
        for pid in all where startTime(of: pid) != nil && startTime(of: pid) == starts[pid] && !isZombie(pid) {
            kill(pid, SIGKILL)
        }
    }

    static func isZombie(_ pid: pid_t) -> Bool {
        guard let info = info(of: pid) else { return false }
        return info.kp_proc.p_stat == SZOMB
    }

    // MARK: File

    private func load() -> [Entry] {
        guard let data = try? Data(contentsOf: file) else { return [] }
        return (try? JSONDecoder().decode([Entry].self, from: data)) ?? []
    }

    private func save(_ entries: [Entry]) {
        if entries.isEmpty {
            try? FileManager.default.removeItem(at: file)
            return
        }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? JSONEncoder().encode(entries).write(to: file, options: .atomic)
    }
}
