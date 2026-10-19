import Foundation

/// Runs blocking work (git, npm, other processes) on a GCD thread. Swift's cooperative thread
/// pool has one thread per core; a `Task.detached` that waits on a process holds one of them,
/// and enough of those stall every async task in the app.
public func blocking<T: Sendable>(_ work: @escaping @Sendable () -> T) async -> T {
    await withCheckedContinuation { continuation in
        DispatchQueue.global(qos: .userInitiated).async { continuation.resume(returning: work()) }
    }
}

public func blocking<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
        DispatchQueue.global(qos: .userInitiated).async { continuation.resume(with: Result { try work() }) }
    }
}
