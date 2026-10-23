import Foundation
import CoreFoundation

/// Reject missing, boolean, fractional, negative and out-of-range counters instead of inventing zero.
enum SubagentTokenCounter {
    static func read(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let value = number.doubleValue
        guard value.isFinite, value >= 0, value.rounded() == value, value < Double(Int.max) else { return nil }
        return Int(value)
    }
}
