package com.urn.sdk.routing

import com.aeris.sdk.BridgeDispatcher
import java.util.ArrayDeque

/** RN 调用线程先在锁内计量，再只安排一个有界批次任务，避免 dispatcher 本身变成无界队列。 */
internal class URNMessageInbox(
    private val dispatcher: BridgeDispatcher,
    private val budget: URNChannelBudget,
    private val deliver: (URNAddress, String) -> Unit,
    private val fault: (URNAddress) -> Unit,
) {
    private data class Frame(val text: String, val bytes: Int)
    private class Page {
        val waiting = ArrayDeque<Frame>()
        var messages = 0
        var bytes = 0L
        var blocked = false
    }
    private data class Transfer(val address: URNAddress, val page: Page, val frame: Frame)
    private val pages = linkedMapOf<URNAddress, Page>()
    private var messages = 0
    private var bytes = 0L
    private var cursor = 0
    private var scheduled = false
    private var invalidated = false

    @Synchronized fun snapshot(address: URNAddress): URNQueueSnapshot {
        val page = pages[address] ?: return URNQueueSnapshot(0, 0)
        return URNQueueSnapshot(page.messages, page.bytes)
    }

    @Synchronized fun register(address: URNAddress) { check(!invalidated); pages[address] = Page() }
    @Synchronized fun retire(address: URNAddress) {
        val page = pages.remove(address) ?: return
        discardWaiting(page)
        // 已交给 Aeris dispatcher 的帧继续计量，不能通过反复关闭/新开页面逃逸总预算。
    }

    private fun discardWaiting(page: Page) {
        page.waiting.forEach { release(page, it) }
        page.waiting.clear()
    }
    private fun release(page: Page, frame: Frame) {
        page.messages--
        page.bytes -= frame.bytes
        messages--
        bytes -= frame.bytes
    }

    fun enqueue(address: URNAddress, text: String): Boolean {
        var failed = false
        synchronized(this) {
            val page = pages[address] ?: return false
            if (invalidated || page.blocked) return false
            val size = frameBytes(text, budget.maxFrameBytes)
            if (size == null || page.messages >= budget.nativePageMessages ||
                page.bytes + size > budget.nativePageBytes || messages >= budget.nativeMessages ||
                bytes + size > budget.nativeBytes) {
                page.blocked = true
                discardWaiting(page)
                failed = true
            } else {
                page.waiting.add(Frame(text, size))
                page.messages++
                page.bytes += size
                messages++
                bytes += size
                schedule()
            }
        }
        if (failed) dispatcher.execute { fault(address) }
        return !failed
    }

    private fun schedule() {
        if (!scheduled && !invalidated) {
            scheduled = true
            dispatcher.execute { drain() }
        }
    }

    private fun drain() {
        repeat(budget.nativeBatchSize) {
            val next = synchronized(this) {
                if (invalidated || pages.values.none { it.waiting.isNotEmpty() }) {
                    scheduled = false
                    return
                }
                val entries = pages.entries.toList()
                var picked: Transfer? = null
                repeat(entries.size) {
                    if (picked == null) {
                        val entry = entries[cursor % entries.size]
                        cursor = (cursor + 1) % entries.size
                        if (entry.value.waiting.isNotEmpty()) {
                            val frame = entry.value.waiting.removeFirst()
                            picked = Transfer(entry.key, entry.value, frame)
                        }
                    }
                }
                picked
            }
            if (next != null) {
                try { deliver(next.address, next.frame.text) }
                finally {
                    // Transport.receive 本身异步 dispatch；同一串行 dispatcher 的后续屏障才表示已处理。
                    dispatcher.execute {
                        synchronized(this) {
                            if (!invalidated) release(next.page, next.frame)
                        }
                    }
                }
            }
        }
        synchronized(this) {
            scheduled = false
            if (pages.values.any { it.waiting.isNotEmpty() }) schedule()
        }
    }

    @Synchronized fun snapshot(): Pair<Int, Long> = messages to bytes
    @Synchronized fun invalidate() {
        invalidated = true
        pages.clear()
        messages = 0
        bytes = 0
    }
}
