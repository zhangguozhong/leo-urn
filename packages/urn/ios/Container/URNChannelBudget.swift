import Foundation

// 由 config/channel-budget.json 生成，请修改来源后执行 generate-budget.mjs。
public struct URNChannelBudget: Equatable, Sendable {
    public var maxChannels: Int = 64
    public var maxRetiredChannels: Int = 4096
    public var maxFrameBytes: Int = 262144
    public var jsPageMessages: Int = 64
    public var jsPageBytes: Int = 524288
    public var nativeMessages: Int = 512
    public var nativeBytes: Int = 8388608
    public var nativePageMessages: Int = 64
    public var nativePageBytes: Int = 2097152
    public var nativeBatchSize: Int = 8
    public var nativeOutboundWindow: Int = 4
    public var nativeOutboundGlobalWindow: Int = 64
    public init() {}
    var values: [String: Int] {
        [
            "maxChannels": maxChannels,
            "maxRetiredChannels": maxRetiredChannels,
            "maxFrameBytes": maxFrameBytes,
            "jsPageMessages": jsPageMessages,
            "jsPageBytes": jsPageBytes,
            "nativeMessages": nativeMessages,
            "nativeBytes": nativeBytes,
            "nativePageMessages": nativePageMessages,
            "nativePageBytes": nativePageBytes,
            "nativeBatchSize": nativeBatchSize,
            "nativeOutboundWindow": nativeOutboundWindow,
            "nativeOutboundGlobalWindow": nativeOutboundGlobalWindow,
        ]
    }
}
