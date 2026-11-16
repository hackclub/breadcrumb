import Foundation
import CryptoKit
import Security
import LocalAuthentication

enum VaultKey {
    static func load(allowInteraction: Bool = true, createIfMissing: Bool = true) throws -> SymmetricKey {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                   kSecAttrService as String: "app.rewind.local.encryption",
                                   kSecAttrAccount as String: "capture-library"]
        var previousInteraction: DarwinBoolean = false
        if !allowInteraction {
            let context = LAContext()
            context.interactionNotAllowed = true
            query[kSecUseAuthenticationContext as String] = context
            // LAContext's UI suppression alone does not cover legacy macOS Keychain items.
            // This process-scoped compatibility API is restored before the single-flight load ends.
            let read = SecKeychainGetUserInteractionAllowed(&previousInteraction)
            guard read == errSecSuccess else { throw KeyError.access(read) }
            let changed = SecKeychainSetUserInteractionAllowed(false)
            guard changed == errSecSuccess else { throw KeyError.access(changed) }
        }
        defer {
            if !allowInteraction { SecKeychainSetUserInteractionAllowed(previousInteraction.boolValue) }
        }
        var search = query
        search[kSecReturnData as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(search as CFDictionary, &item)
        if status == errSecSuccess {
            guard let bytes = item as? Data, bytes.count == 32 else { throw KeyError.invalid }
            return SymmetricKey(data: bytes)
        }
        guard status == errSecItemNotFound else { throw KeyError.access(status) }
        // Missing access to an existing history's key must never create a replacement key.
        guard createIfMissing else { throw KeyError.access(status) }
        let key = SymmetricKey(size: .bits256)
        var entry = query
        entry[kSecValueData as String] = key.withUnsafeBytes { Data($0) }
        entry[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let saved = SecItemAdd(entry as CFDictionary, nil)
        guard saved == errSecSuccess else { throw KeyError.access(saved) }
        return key
    }

    enum KeyError: LocalizedError {
        case access(OSStatus)
        case invalid
        var isRetryable: Bool {
            guard case .access(let status) = self else { return false }
            return [errSecNotAvailable, errSecAuthFailed, errSecInteractionNotAllowed,
                    errSecUserCanceled, errSecItemNotFound, errSecDuplicateItem].contains(status)
        }
        var errorDescription: String? {
            if isRetryable {
                return "The encryption key is unavailable in Keychain. Unlock your login keychain or approve access when macOS asks. Breadcrumb retries quietly each minute without changing your recording preference. No unencrypted fallback or replacement key is used for existing history."
            }
            return "The encryption key could not be read. Your encrypted history has not been replaced."
        }
    }
}
