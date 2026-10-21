import Foundation
import Testing

extension Trait where Self == ConditionTrait {
    /// For tests that check how long something took: shared CI runners are too busy for that to mean anything, so they run only locally.
    static var wallClock: Self {
        .disabled(if: ProcessInfo.processInfo.environment["CI"] != nil, "wall-clock timing is unreliable on shared CI runners")
    }
}
