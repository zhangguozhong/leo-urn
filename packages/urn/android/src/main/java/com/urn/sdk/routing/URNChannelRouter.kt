package com.urn.sdk.routing

import com.google.gson.JsonParser
import com.aeris.sdk.AerisRNNativeTransport
import com.aeris.sdk.BridgeEngine
import com.aeris.sdk.BridgeUIContext
import java.util.logging.Logger

data class URNQueueSnapshot(val messages: Int, val bytes: Long)

/** 一个实例只属于一个实际 Runtime；reload 必须关闭旧实例并创建新的 generation。 */
class URNChannelRouter(
    private val engine: BridgeEngine,
    val generation: String,
    val budget: URNChannelBudget = URNChannelBudget(),
    sink: URNEventSink? = null,
    private val onPageDisconnected: (URNAddress, String, String) -> Unit = { _, _, _ -> },
) {
    private val pages = linkedMapOf<URNAddress, URNPageConnection>()
    private val retired = mutableSetOf<URNAddress>()
    private var closed = false
    private var sink = sink
    private val outbox = URNMessageOutbox(generation, engine.dispatcher, budget) { address ->
        fail(address, "BACKPRESSURE", "原生出站消息、字节或控制槽预算超额，或事件发送失败")
    }
    private val inbox = URNMessageInbox(engine.dispatcher, budget, { address, message ->
        pages[address]?.transport?.receive(message)
    }, { address -> fail(address, "BACKPRESSURE", "原生入站消息或字节预算超额") })

    init {
        require(validIdentity(generation)) { "运行轮次标识无效" }
        engine.dispatcher.checkThread()
        outbox.setSink(sink)
    }

    fun queueSnapshot(address: URNAddress): URNQueueSnapshot {
        engine.dispatcher.checkThread()
        val outbound = outbox.snapshot(address)
        val inbound = inbox.snapshot(address)
        return URNQueueSnapshot(outbound.messages + inbound.messages, outbound.bytes + inbound.bytes)
    }

    val count: Int get() { engine.dispatcher.checkThread(); return pages.size }

    fun open(
        address: URNAddress,
        uiContext: BridgeUIContext? = null,
        allowedPermissions: Set<String> = emptySet(),
        allowedEventTopics: Set<String>? = null,
    ): URNPageConnection {
        engine.dispatcher.checkThread()
        require(!closed && address.isValid && address.generation == generation) { "通道不属于当前活动运行轮次" }
        require(address !in pages && address !in retired) { "通道不能重复绑定或重新启用" }
        require(pages.size < budget.maxChannels && retired.size < budget.maxRetiredChannels) { "页面或退役通道达到预算" }
        require(outbox.register(address)) { "未确认消息仍占据页面预算，请等待消费确认或重建 Runtime" }
        val transport = try {
            AerisRNNativeTransport(engine, uiContext, allowedPermissions, allowedEventTopics) { text ->
                // Core.fail 先标记 isClosed 再 emit 紧急 bridge.close，仍必须交给有界控制槽。
                if (!closed && address in pages) {
                    val emergency = runCatching {
                        JsonParser.parseString(text).asJsonObject.get("method")?.asString == "bridge.close"
                    }.getOrDefault(false)
                    outbox.enqueue(address, URNFrameKind.MESSAGE, text, if (emergency) URNControlSlot.EMERGENCY else null)
                }
            }
        } catch (error: Exception) {
            retired.add(address)
            outbox.retire(address)
            throw error
        }
        val page = URNPageConnection(address, uiContext, transport, this)
        pages[address] = page
        inbox.register(address)
        transport.connection.onClosed = { error ->
            if (error == null) retire(address, closeConnection = false)
            else fail(address, error.code, error.message)
        }
        return page
    }

    fun contains(address: URNAddress): Boolean {
        engine.dispatcher.checkThread()
        return !closed && address.generation == generation && address in pages
    }

    /** 允许 RN 调用线程直接入队；其余变更必须在 Engine dispatcher 上执行。 */
    fun receive(address: URNAddress, message: String): Boolean {
        if (!address.isValid || address.generation != generation) return false
        return inbox.enqueue(address, message)
    }

    fun setEventSink(sink: URNEventSink?) {
        engine.dispatcher.checkThread()
        if (closed) return
        this.sink = sink
        outbox.setSink(sink)
    }
    fun boot(generation: String): Boolean {
        engine.dispatcher.checkThread()
        if (closed || generation != this.generation) return false
        outbox.boot()
        return true
    }
    fun mounted(address: URNAddress): Boolean {
        engine.dispatcher.checkThread()
        if (!contains(address)) return false
        outbox.mounted(address)
        return true
    }
    fun acknowledge(address: URNAddress, deliveryId: String): Boolean {
        engine.dispatcher.checkThread()
        if (!address.isValid) return false
        return outbox.acknowledge(address, deliveryId)
    }
    fun enqueuePageEvent(address: URNAddress, message: String, control: Boolean = false): Boolean {
        engine.dispatcher.checkThread()
        if (!contains(address)) return false
        return outbox.enqueue(address, URNFrameKind.PAGE_EVENT, message, if (control) URNControlSlot.PAGE_RESULT else null)
    }
    fun enqueueCloseRequested(address: URNAddress, reason: String): Boolean {
        engine.dispatcher.checkThread()
        if (!contains(address)) return false
        return outbox.enqueue(address, URNFrameKind.CLOSE_REQUESTED, reason, URNControlSlot.CLOSE)
    }

    fun beginClosing(address: URNAddress) {
        engine.dispatcher.checkThread()
        // 直接同步 Core 状态，确保紧随其后的新业务请求无法插入关闭窗口。
        pages[address]?.connection?.beginClosing()
    }
    fun close(address: URNAddress) {
        engine.dispatcher.checkThread()
        retire(address, closeConnection = true)
    }
    private fun retire(address: URNAddress, closeConnection: Boolean) {
        val page = pages.remove(address) ?: return
        // 先摘表并退役，再触发可能重入的业务 onCancel。
        retired.add(address)
        inbox.retire(address)
        outbox.retire(address)
        if (closeConnection) page.connection.close()
    }
    private fun fail(address: URNAddress, code: String, message: String) {
        if (closed || address !in pages) return
        Logger.getLogger("URNChannelRouter").warning("URN 页面通道失败 generation=${address.generation} channel=${address.channel} code=$code: $message")
        outbox.enqueue(address, URNFrameKind.CLOSE_REQUESTED, code, URNControlSlot.CLOSE)
        retire(address, closeConnection = true)
        runCatching { onPageDisconnected(address, code, message) }.onFailure {
            Logger.getLogger("URNChannelRouter").warning("URN 页面断开回调失败: ${it.javaClass.simpleName}")
        }
    }

    /** 仅整轮故障使用无 channel 的 Spec 事件，避免单页故障影响其它页面。 */
    fun disconnect(code: String, message: String) {
        engine.dispatcher.checkThread()
        if (closed) return
        val target = sink
        closeAll()
        runCatching { target?.onDisconnect(generation, code, message) }
    }
    fun closeAll() {
        engine.dispatcher.checkThread()
        if (closed) return
        closed = true
        val active = pages.values.toList()
        pages.clear()
        inbox.invalidate()
        outbox.invalidate()
        sink = null
        active.forEach { retired.add(it.address); it.connection.close() }
    }
    fun snapshot(): URNRouterSnapshot {
        engine.dispatcher.checkThread()
        val inbound = inbox.snapshot()
        val outbound = outbox.snapshot()
        return URNRouterSnapshot(inbound.first, inbound.second, outbound.first, outbound.second, outbound.third.first, outbound.third.second, pages.size)
    }
}
