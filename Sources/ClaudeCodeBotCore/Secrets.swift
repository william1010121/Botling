import Foundation
import Security

/// Where plugins' secret settings (passwords, tokens) are kept: never in plugins.json, never in
/// a chat.
public protocol SecretStore: Sendable {
    func get(plugin: String, key: String) -> String?
    func set(plugin: String, key: String, value: String?)
}

/// The macOS keychain: one generic password per plugin setting, service 「ClaudeCodeBot plugin <name>」.
public struct KeychainSecretStore: SecretStore {
    public init() {}

    private func query(_ plugin: String, _ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "ClaudeCodeBot plugin \(plugin)",
            kSecAttrAccount as String: key
        ]
    }

    public func get(plugin: String, key: String) -> String? {
        var request = query(plugin, key)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func set(plugin: String, key: String, value: String?) {
        let item = query(plugin, key)
        SecItemDelete(item as CFDictionary)
        guard let value, !value.isEmpty else { return }
        var add = item
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrLabel as String] = "ClaudeCodeBot 插件 \(plugin)：\(key)"
        SecItemAdd(add as CFDictionary, nil)
    }
}

/// For tests: secrets in memory.
public final class MemorySecretStore: SecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]

    public init() {}

    public func get(plugin: String, key: String) -> String? {
        lock.withLock { values["\(plugin)\u{0}\(key)"] }
    }

    public func set(plugin: String, key: String, value: String?) {
        lock.withLock { values["\(plugin)\u{0}\(key)"] = value?.isEmpty == false ? value : nil }
    }
}
