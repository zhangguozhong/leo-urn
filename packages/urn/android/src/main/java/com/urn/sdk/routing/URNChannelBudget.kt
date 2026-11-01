package com.urn.sdk.routing

// 由 config/channel-budget.json 生成，请修改来源后执行 generate-budget.mjs。
data class URNChannelBudget(
    val maxChannels: Int = 64,
    val maxRetiredChannels: Int = 4096,
    val maxFrameBytes: Int = 262144,
    val jsPageMessages: Int = 64,
    val jsPageBytes: Int = 524288,
    val nativeMessages: Int = 512,
    val nativeBytes: Int = 8388608,
    val nativePageMessages: Int = 64,
    val nativePageBytes: Int = 2097152,
    val nativeBatchSize: Int = 8,
    val nativeOutboundWindow: Int = 4,
    val nativeOutboundGlobalWindow: Int = 64,
) {
    init { validateChannelBudget(this) }

    fun values(): Map<String, Int> = mapOf(
        "maxChannels" to maxChannels,
        "maxRetiredChannels" to maxRetiredChannels,
        "maxFrameBytes" to maxFrameBytes,
        "jsPageMessages" to jsPageMessages,
        "jsPageBytes" to jsPageBytes,
        "nativeMessages" to nativeMessages,
        "nativeBytes" to nativeBytes,
        "nativePageMessages" to nativePageMessages,
        "nativePageBytes" to nativePageBytes,
        "nativeBatchSize" to nativeBatchSize,
        "nativeOutboundWindow" to nativeOutboundWindow,
        "nativeOutboundGlobalWindow" to nativeOutboundGlobalWindow,
    )
}
