import Foundation

/// Last-mile environment filtering for every app-owned child, including helpers whose
/// environment would otherwise be inherited implicitly. Never mutate global environ.
public enum ChildEnvironment {
    public static func sanitized(_ values: [String: String]) -> [String: String] {
        var values = values
        values.removeValue(forKey: "CCB_TELEGRAM_TOKEN")
        return values
    }

    public static func run(_ process: Process) throws {
        process.environment = sanitized(process.environment ?? ProcessInfo.processInfo.environment)
        try process.run()
    }
}
