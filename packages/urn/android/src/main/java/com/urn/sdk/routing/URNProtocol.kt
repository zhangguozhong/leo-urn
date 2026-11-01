package com.urn.sdk.routing

import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction

data class URNAddress(val generation: String, val channel: String) {
    val isValid: Boolean get() = validIdentity(generation) && validIdentity(channel)
}

internal fun validIdentity(value: String): Boolean = value.length in 1..80 && value.all {
    it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '_' || it == '-'
}

/** 字段逐项对应现有 Codegen Spec；单页故障不能发送运行轮次级 onDisconnect。 */
interface URNEventSink {
    fun onMessage(runtimeGeneration: String, channelId: String, deliveryId: String, message: String)
    fun onPageEvent(runtimeGeneration: String, channelId: String, deliveryId: String, message: String)
    fun onCloseRequested(runtimeGeneration: String, channelId: String, deliveryId: String, reason: String)
    fun onDisconnect(runtimeGeneration: String, code: String, message: String)
}

data class URNRouterSnapshot(
    val inboundMessages: Int,
    val inboundBytes: Long,
    val outboundMessages: Int,
    val outboundBytes: Long,
    val inFlight: Int,
    val controlMessages: Int,
    val channels: Int,
)

/** 使用严格 UTF-8，拒绝孤立代理项；先检查字符数，避免超长帧分配第二份缓冲区。 */
internal fun frameBytes(text: String, maximum: Int): Int? {
    if (text.length > maximum) return null
    return try {
        val encoded = Charsets.UTF_8.newEncoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .encode(CharBuffer.wrap(text))
        encoded.remaining().takeIf { it <= maximum }
    } catch (_: java.nio.charset.CharacterCodingException) { null }
}

/** 与 JS readRuntimeBudget 使用同一上限和关系；无隐式 min/max 或预算降级。 */
internal fun validateChannelBudget(b: URNChannelBudget) {
    require(b.values().values.all { it > 0 }) { "运行时预算必须是正整数" }
    require(
        b.maxChannels <= 64 && b.maxRetiredChannels <= 65536 &&
            b.maxFrameBytes <= 16 * 1024 * 1024 && b.jsPageMessages <= 65536 &&
            b.nativeMessages <= 65536 && b.nativePageMessages <= 65536 &&
            b.jsPageBytes <= 64 * 1024 * 1024 && b.nativePageBytes <= 64 * 1024 * 1024 &&
            b.nativeBytes <= 256 * 1024 * 1024 && b.jsPageBytes >= b.maxFrameBytes &&
            b.nativePageBytes >= b.maxFrameBytes && b.nativeBytes >= b.nativePageBytes &&
            b.nativeMessages >= b.nativePageMessages && b.nativeOutboundWindow <= 64 &&
            b.nativeOutboundGlobalWindow <= 512 && b.nativeOutboundGlobalWindow >= b.maxChannels &&
            b.nativeBatchSize <= 512 && b.nativeBatchSize <= b.nativeMessages
    ) { "预算超过安全上限或单帧/单页/总量关系不一致" }
}
