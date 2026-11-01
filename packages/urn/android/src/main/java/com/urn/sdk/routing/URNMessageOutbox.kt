package com.urn.sdk.routing

import com.aeris.sdk.BridgeDispatcher
import java.util.UUID

internal enum class URNFrameKind { MESSAGE, PAGE_EVENT, CLOSE_REQUESTED }
internal enum class URNControlSlot { EMERGENCY, PAGE_RESULT, CLOSE }

/** 等待和已交给 RN 的消息共同占预算，只有确认或 Runtime 销毁才能释放在途内存。 */
internal class URNMessageOutbox(
    private val generation: String,
    private val dispatcher: BridgeDispatcher,
    private val budget: URNChannelBudget,
    private val fault: (URNAddress) -> Unit,
) {
    private data class Frame(
        val address: URNAddress, val kind: URNFrameKind, val text: String, val bytes: Int,
        val slot: URNControlSlot?, val id: String = UUID.randomUUID().toString(),
    )
    private class Page {
        val waiting = mutableListOf<Frame>()
        val slots = mutableSetOf<URNControlSlot>()
        var mounted = false
        var retired = false
        var failed = false
        var messages = 0
        var bytes = 0L
        var inFlight = 0
    }
    private val pages = linkedMapOf<URNAddress, Page>()
    private val flying = mutableMapOf<String, Pair<Frame, Page>>()
    private var cursor = 0
    private var messages = 0
    private var bytes = 0L
    private var inFlight = 0
    private var controls = 0
    private var booted = false
    private var scheduled = false
    private var draining = false
    private var invalidated = false
    private var sink: URNEventSink? = null

    fun snapshot(address: URNAddress): URNQueueSnapshot {
        val waiting = pages[address]?.waiting.orEmpty()
        val active = flying.values.map { it.first }.filter { it.address == address }
        return URNQueueSnapshot(waiting.size + active.size, waiting.sumOf { it.bytes.toLong() } + active.sumOf { it.bytes.toLong() })
    }

    fun register(address: URNAddress): Boolean {
        // 退役页若还持有在途消息或关闭意图，继续占据槽位，避免反复开关页面逃逸总量。
        if (invalidated || pages.size >= budget.maxChannels || pages.containsKey(address)) return false
        pages[address] = Page()
        return true
    }
    fun setSink(value: URNEventSink?) { sink = value; schedule() }
    fun boot() { booted = true; schedule() }
    fun mounted(address: URNAddress) { pages[address]?.mounted = true; schedule() }

    fun enqueue(address: URNAddress, kind: URNFrameKind, text: String, slot: URNControlSlot? = null): Boolean {
        val page = pages[address] ?: return false
        if (invalidated || (page.failed && slot == null) || (page.retired && slot == null)) return false
        val maximum = if (slot == URNControlSlot.CLOSE || slot == URNControlSlot.EMERGENCY) 1024 else budget.maxFrameBytes
        val size = frameBytes(text, maximum)
        val exceeds = size == null || if (slot != null) {
            slot in page.slots
        } else {
            page.messages >= budget.nativePageMessages || page.bytes + size > budget.nativePageBytes ||
                messages >= budget.nativeMessages || bytes + size > budget.nativeBytes
        }
        if (exceeds) {
            if (!page.failed) {
                page.failed = true
                discardWaiting(page)
                fault(address)
            }
            return false
        }
        val frame = Frame(address, kind, text, requireNotNull(size), slot)
        page.waiting.add(frame)
        if (slot == null) {
            page.messages++
            page.bytes += frame.bytes
            messages++
            bytes += frame.bytes
        } else {
            page.slots.add(slot)
            controls++
        }
        schedule()
        return true
    }

    fun acknowledge(address: URNAddress, id: String): Boolean {
        if (invalidated || address.generation != generation) return false
        val (frame, page) = flying[id] ?: return false
        if (frame.address != address) return false
        flying.remove(id)
        release(frame, page)
        if (frame.slot == null) { page.inFlight--; inFlight-- }
        removeRetired(address, page)
        schedule()
        return true
    }

    private fun release(frame: Frame, page: Page) {
        if (frame.slot == null) {
            page.messages--
            page.bytes -= frame.bytes
            messages--
            bytes -= frame.bytes
        } else {
            page.slots.remove(frame.slot)
            controls--
        }
    }
    private fun discardWaiting(page: Page) {
        val discarded = page.waiting.filter { it.slot == null }
        discarded.forEach { release(it, page) }
        page.waiting.removeAll(discarded.toSet())
    }
    fun retire(address: URNAddress) {
        val page = pages[address] ?: return
        page.retired = true
        page.failed = true
        discardWaiting(page)
        removeRetired(address, page)
        schedule()
    }
    private fun removeRetired(address: URNAddress, page: Page) {
        if (page.retired && page.waiting.isEmpty() && page.messages == 0 && page.slots.isEmpty()) pages.remove(address)
    }

    private fun deliverable(page: Page): Frame? {
        if (!page.mounted) return null
        // 控制帧每页每种一个槽；不依赖已被慢消费者占满的普通确认窗口。
        page.waiting.firstOrNull { it.slot != null }?.let { return it }
        if (!page.retired && page.inFlight < budget.nativeOutboundWindow && inFlight < budget.nativeOutboundGlobalWindow)
            return page.waiting.firstOrNull()
        return null
    }
    private fun schedule() {
        if (!invalidated && !scheduled && !draining && booted && sink != null && pages.values.any { deliverable(it) != null }) {
            scheduled = true
            dispatcher.execute { drain() }
        }
    }
    private fun drain() {
        scheduled = false
        if (invalidated || !booted || sink == null) return
        draining = true
        try {
            repeat(budget.nativeBatchSize) {
                val target = sink ?: return
                val entries = pages.entries.toList()
                var selected: Pair<Frame, Page>? = null
                repeat(entries.size) {
                    if (selected == null) {
                        val entry = entries[cursor % entries.size]
                        cursor = (cursor + 1) % entries.size
                        val frame = deliverable(entry.value)
                        if (frame != null) selected = frame to entry.value
                    }
                }
                val (frame, page) = selected ?: return
                page.waiting.remove(frame)
                flying[frame.id] = frame to page
                if (frame.slot == null) { page.inFlight++; inFlight++ }
                // 先登记在途再调用外部 sink，允许同步确认或关闭重入。
                try {
                    when (frame.kind) {
                        URNFrameKind.MESSAGE -> target.onMessage(generation, frame.address.channel, frame.id, frame.text)
                        URNFrameKind.PAGE_EVENT -> target.onPageEvent(generation, frame.address.channel, frame.id, frame.text)
                        URNFrameKind.CLOSE_REQUESTED -> target.onCloseRequested(generation, frame.address.channel, frame.id, frame.text)
                    }
                } catch (_: Exception) {
                    // 无法证明 RN 是否已接收，保留在途计量并停止该 sink，避免重复首包。
                    sink = null
                    fault(frame.address)
                    return
                }
            }
        } finally {
            draining = false
            schedule()
        }
    }

    fun snapshot(): Triple<Int, Long, Pair<Int, Int>> = Triple(messages, bytes, inFlight to controls)
    fun invalidate() {
        invalidated = true
        sink = null
        pages.clear()
        flying.clear()
        messages = 0
        bytes = 0
        inFlight = 0
        controls = 0
    }
}
