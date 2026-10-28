import Foundation

/// 容器错误不替代 Aeris 的业务错误，保留独立错误码便于接入诊断。
public struct URNContainerError: Error, LocalizedError, Sendable {
    public let code: String
    public let message: String
    public var errorDescription: String? { message }

    public init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }
}

/// 地址只用于容器通道，绝不写入 Aeris 的请求 JSON。
struct URNAddress: Hashable, Sendable {
    let generation: String
    let channel: String

    var isValid: Bool {
        [generation, channel].allSatisfy { value in
            !value.isEmpty && value.utf8.count <= 80
                && value.utf8.allSatisfy {
                    (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0)
                        || $0 == 45 || $0 == 95
                }
        }
    }
}
