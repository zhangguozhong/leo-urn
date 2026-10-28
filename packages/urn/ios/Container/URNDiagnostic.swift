import Foundation

/// 仅含容器生成的关联标识与指标；业务入口标识须由宿主显式选择记录。
public struct URNDiagnostic: Codable, Sendable {
    public let timestampMs: Double
    public let stage: String
    public let runtimeGeneration: String?
    public let pageId: String?
    public let channelId: String?
    public let featureId: String?
    public let durationMs: Double?
    public let code: String?
    public let queuedMessages: Int?
    public let queuedBytes: Int?
}
