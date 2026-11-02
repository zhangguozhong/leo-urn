package com.urn.sdk.routing

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.aeris.sdk.*
import org.junit.Assert.*
import org.junit.Test
import java.util.ArrayDeque

/** 只替代线程和时钟；业务路径使用真正的 Aeris Transport/Connection/Session。 */
private class TestDispatcher : BridgeDispatcher {
    private val tasks = ArrayDeque<() -> Unit>()
    override fun checkThread() = Unit
    override fun execute(action: () -> Unit) { tasks.add(action) }
    override fun schedule(delayMs: Long, action: () -> Unit): BridgeCancellation {
        if (delayMs == 0L) tasks.add(action)
        return BridgeCancellation { tasks.remove(action) }
    }
    fun runNext() { tasks.removeFirst().invoke() }
    fun drain() {
        var steps = 0
        while (tasks.isNotEmpty()) {
            check(++steps < 10000) { "dispatcher 未收敛，疑似无确认时仍持续调度" }
            tasks.removeFirst().invoke()
        }
    }
}

private data class Frame(val kind: String, val generation: String, val channel: String, val id: String, val text: String)
private class Sink : URNEventSink {
    val frames = mutableListOf<Frame>()
    val disconnected = mutableListOf<String>()
    override fun onMessage(runtimeGeneration: String, channelId: String, deliveryId: String, message: String) { frames.add(Frame("message", runtimeGeneration, channelId, deliveryId, message)) }
    override fun onPageEvent(runtimeGeneration: String, channelId: String, deliveryId: String, message: String) { frames.add(Frame("page", runtimeGeneration, channelId, deliveryId, message)) }
    override fun onCloseRequested(runtimeGeneration: String, channelId: String, deliveryId: String, reason: String) { frames.add(Frame("close", runtimeGeneration, channelId, deliveryId, reason)) }
    override fun onDisconnect(runtimeGeneration: String, code: String, message: String) { disconnected.add("$runtimeGeneration:$code") }
}

class URNChannelRouterTest {
    private val clock = TestDispatcher()
    private val engine = BridgeEngine(clock)
    private val sink = Sink()
    private val faults = mutableListOf<URNAddress>()
    private val a = URNAddress("runtime", "A")
    private val b = URNAddress("runtime", "B")
    private fun router(budget: URNChannelBudget = URNChannelBudget()) = URNChannelRouter(engine, "runtime", budget, sink) { address, _, _ -> faults.add(address) }
    private fun request(method: String, id: String, params: String = "{}") = "{\"method\":\"$method\",\"callbackId\":\"$id\",\"params\":$params}"
    private fun ready(router: URNChannelRouter, vararg pages: URNAddress) { router.boot("runtime"); pages.forEach { router.mounted(it) }; clock.drain() }
    private fun ackAll(router: URNChannelRouter) { sink.frames.toList().forEach { router.acknowledge(URNAddress(it.generation, it.channel), it.id) }; clock.drain() }

    class Echo : BridgeModule {
        override val moduleName = "DefaultBridge"
        val sessions = mutableListOf<BridgeSession>()
        @BridgeMethod fun hold(session: BridgeSession) { sessions.add(session) }
        @BridgeMethod(permission = "secret") fun secret(session: BridgeSession) { session.callback(session.params) }
    }

    @Test fun diagnosticQueueSnapshotIncludesInFlightAndOnlyMatchingPage() {
        val router = router()
        router.open(a); router.open(b)
        ready(router, a, b)
        assertTrue(router.enqueuePageEvent(a, "snapshot"))
        assertEquals(URNQueueSnapshot(1, 8), router.queueSnapshot(a))
        assertEquals(URNQueueSnapshot(0, 0), router.queueSnapshot(b))
        clock.drain()
        assertEquals(URNQueueSnapshot(1, 8), router.queueSnapshot(a))
        ackAll(router)
        assertEquals(URNQueueSnapshot(0, 0), router.queueSnapshot(a))
    }

    @Test fun defaultBudgetExactlyMatchesSourceWithoutWindowClamping() {
        val budget = URNChannelBudget()
        assertEquals(4, budget.nativeOutboundWindow)
        assertEquals(64, budget.nativeOutboundGlobalWindow)
        val resource = requireNotNull(javaClass.getResource("/channel-budget.json")) { "缺少真实预算源文件测试资源" }
        val source = JsonParser.parseString(resource.readText()).asJsonObject
        budget.values().forEach { (key, value) -> assertEquals(key, source.get(key).asInt, value) }
        assertThrows(IllegalArgumentException::class.java) { budget.copy(nativeOutboundWindow = 65) }
        assertThrows(IllegalArgumentException::class.java) { budget.copy(nativePageBytes = 1) }
    }

    @Test fun oldGenerationAndRetiredChannelCannotReopen() {
        val router = router()
        router.open(a)
        assertThrows(IllegalArgumentException::class.java) { router.open(a) }
        assertFalse(router.receive(a.copy(generation = "old"), "{}"))
        router.close(a)
        assertThrows(IllegalArgumentException::class.java) { router.open(a) }
        router.closeAll()
        assertThrows(IllegalArgumentException::class.java) { router.open(b) }
        assertFalse(router.boot("old"))
        assertEquals(0, engine.connectionCount)
    }

    @Test fun firstFrameSurvivesBootMountedAndSinkOrdering() {
        val router = router()
        router.open(a)
        assertTrue(router.enqueuePageEvent(a, "first"))
        clock.drain()
        assertTrue(sink.frames.isEmpty())
        router.boot("runtime")
        clock.drain()
        assertTrue(sink.frames.isEmpty())
        router.setEventSink(null)
        router.mounted(a)
        clock.drain()
        assertTrue(sink.frames.isEmpty())
        router.setEventSink(sink)
        clock.drain()
        assertEquals("first", sink.frames.single().text)
        assertTrue(router.acknowledge(a, sink.frames.single().id))
        assertFalse(router.acknowledge(a, sink.frames.single().id))
    }

    @Test fun actualPerPageWindowIsFourAndAcksCannotCrossPageOrGeneration() {
        val router = router()
        router.open(a); router.open(b)
        repeat(8) { router.enqueuePageEvent(a, "A$it"); router.enqueuePageEvent(b, "B$it") }
        ready(router, a, b)
        assertEquals(4, sink.frames.count { it.channel == "A" })
        assertEquals(4, sink.frames.count { it.channel == "B" })
        assertEquals(listOf("A", "B", "A", "B"), sink.frames.take(4).map { it.channel })
        val first = sink.frames.first()
        assertFalse(router.acknowledge(b, first.id))
        assertFalse(router.acknowledge(a.copy(generation = "old"), first.id))
        clock.drain()
        assertEquals(8, sink.frames.size)
        assertTrue(router.acknowledge(a, first.id))
        clock.drain()
        assertEquals(9, sink.frames.size)
    }

    @Test fun globalWindowIs64AndControlsUseReservedSlots() {
        val router = router()
        val pages = (0 until 20).map { URNAddress("runtime", "page$it") }
        pages.forEach { router.open(it); repeat(5) { n -> router.enqueuePageEvent(it, "$n") } }
        ready(router, *pages.toTypedArray())
        assertEquals(64, sink.frames.size)
        pages.forEach { assertTrue(router.enqueueCloseRequested(it, "host")) }
        clock.drain()
        assertEquals(20, sink.frames.count { it.kind == "close" })
        assertEquals(64, sink.frames.count { it.kind == "page" })
    }

    @Test fun slowPageRetirementDoesNotReleaseUnacknowledgedMemory() {
        val router = router()
        router.open(a); router.open(b)
        repeat(4) { router.enqueuePageEvent(a, "aa") }
        ready(router, a, b)
        router.close(a)
        assertEquals(4, router.snapshot().outboundMessages)
        ackAll(router)
        assertEquals(0, router.snapshot().outboundMessages)
        assertTrue(router.enqueuePageEvent(b, "still live"))
        clock.drain()
        assertEquals("B", sink.frames.last().channel)
    }

    @Test fun outboundCountAndByteOverflowSealOnlyFaultingPage() {
        val budget = URNChannelBudget(nativePageMessages = 4, nativeMessages = 8, nativeBatchSize = 2)
        val router = router(budget)
        val page = router.open(a); router.open(b)
        repeat(4) { assertTrue(router.enqueuePageEvent(a, "pending")) }
        assertFalse(router.enqueuePageEvent(a, "overflow"))
        clock.drain()
        assertTrue(page.isClosed)
        assertEquals(listOf(a), faults)
        assertFalse(router.contains(a))
        assertTrue(router.enqueuePageEvent(b, "good"))
        ready(router, b)
        assertEquals("good", sink.frames.last { it.kind == "page" }.text)
        assertTrue(sink.disconnected.isEmpty())
    }

    @Test fun oversizedUtf8AndMalformedSurrogatesAreRejected() {
        val router = router()
        router.open(a); router.open(b)
        assertFalse(router.receive(a, "你".repeat(100000)))
        assertFalse(router.enqueuePageEvent(b, "\uD800"))
        clock.drain()
        assertEquals(setOf(a, b), faults.toSet())
    }

    @Test fun inboundQueueIsBoundedBeforeDispatcherRuns() {
        val router = router(URNChannelBudget(nativePageMessages = 2, nativeBatchSize = 2))
        val page = router.open(a)
        assertTrue(router.receive(a, request("bridge.hello", "c:hello")))
        assertTrue(router.receive(a, request("hold", "c:hold")))
        assertFalse(router.receive(a, request("hold", "c:overflow")))
        assertFalse(router.receive(a, request("hold", "c:late")))
        clock.drain()
        assertTrue(page.isClosed)
        assertEquals(0, router.snapshot().inboundMessages)
        assertEquals(listOf(a), faults)
    }

    @Test fun clientCancelReasonReachesOnlyItsOwnNativeSessionThroughTheRouter() {
        val module = Echo(); engine.register(module)
        val router = router()
        router.open(a); router.open(b)
        ready(router, a, b)
        listOf(a, b).forEach { router.receive(it, request("bridge.hello", "c:hello")) }
        clock.drain(); ackAll(router); sink.frames.clear()
        router.receive(a, request("hold", "c:hold", "{\"owner\":\"A\"}"))
        router.receive(b, request("hold", "c:hold", "{\"owner\":\"B\"}"))
        clock.drain()
        val sessionA = module.sessions.single { it.params.get("owner").asString == "A" }
        val sessionB = module.sessions.single { it.params.get("owner").asString == "B" }
        var cancelledA = 0; var cancelledB = 0
        sessionA.onCancel = { cancelledA++ }
        sessionB.onCancel = { cancelledB++ }
        clock.drain()
        router.receive(a, request("bridge.cancel", "c:cancel", "{\"targetCallbackId\":\"c:hold\",\"reason\":\"user cancelled\"}"))
        clock.drain()
        assertEquals(1, cancelledA)
        assertEquals(0, cancelledB)
        assertEquals(BridgeSessionState.CANCELLED, sessionA.state)
        assertEquals(BridgeSessionState.RUNNING, sessionB.state)
        val ack = sink.frames.map { JsonParser.parseString(it.text).asJsonObject }
            .single { it.get("callbackId")?.asString == "c:cancel" }
        assertTrue(ack.getAsJsonObject("result").get("accepted").asBoolean)
        router.close(b); clock.drain()
        assertEquals(1, cancelledB)
    }

    @Test fun retiredSessionCannotEmitIntoNewGenerationEvenWhenCallbackIdIsReused() {
        val module = Echo(); engine.register(module)
        val old = router()
        old.open(a); ready(old, a)
        old.receive(a, request("bridge.hello", "c:hello")); clock.drain(); ackAll(old)
        old.receive(a, request("hold", "c:same")); clock.drain()
        val retired = module.sessions.single()
        old.closeAll(); clock.drain()
        assertEquals(BridgeSessionState.CLOSED, retired.state)
        val currentAddress = URNAddress("next-runtime", "A")
        val current = URNChannelRouter(engine, "next-runtime", URNChannelBudget(), sink) { _, _, _ -> fail("新通道不应失败") }
        current.open(currentAddress)
        current.boot("next-runtime"); current.mounted(currentAddress)
        current.receive(currentAddress, request("bridge.hello", "c:hello")); clock.drain()
        ackAll(current)
        current.receive(currentAddress, request("hold", "c:same")); clock.drain()
        sink.frames.clear()
        retired.emit(JsonObject().apply { addProperty("stale", true) })
        retired.complete(JsonObject().apply { addProperty("stale", true) })
        clock.drain()
        assertTrue("迟到 Session 不能向任何地址发送数据帧", sink.frames.isEmpty())
        val live = module.sessions.last()
        assertEquals(BridgeSessionState.RUNNING, live.state)
        live.callback(JsonObject().apply { addProperty("live", true) }); clock.drain()
        assertEquals(1, sink.frames.size)
        assertEquals("next-runtime", sink.frames.single().generation)
        assertEquals("A", sink.frames.single().channel)
        assertTrue(sink.frames.single().text.contains("live"))
        current.closeAll(); clock.drain()
        assertEquals(0, engine.connectionCount)
    }

    @Test fun sameCallbackIdAndPermissionRemainIsolatedOnRealAeris() {
        val module = Echo(); engine.register(module)
        val router = router()
        router.open(a); router.open(b)
        ready(router, a, b)
        listOf(a, b).forEach { router.receive(it, request("bridge.hello", "c:hello")) }
        clock.drain(); ackAll(router)
        router.receive(a, request("hold", "c:same", "{\"owner\":\"A\"}"))
        router.receive(b, request("hold", "c:same", "{\"owner\":\"B\"}"))
        clock.drain()
        assertEquals(2, module.sessions.size)
        module.sessions.forEach { it.callback(it.params) }
        clock.drain()
        val callbacks = sink.frames.filter { it.text.contains("c:same") }
        assertEquals(setOf("A", "B"), callbacks.map { JsonParser.parseString(it.text).asJsonObject.getAsJsonObject("result").get("owner").asString }.toSet())
        callbacks.forEach { assertEquals(it.channel, JsonParser.parseString(it.text).asJsonObject.getAsJsonObject("result").get("owner").asString) }
        router.receive(a, request("secret", "c:secret")); clock.drain()
        assertTrue(sink.frames.last().text.contains("PERMISSION_DENIED"))
    }

    @Test fun beginClosingUsesRealCoreBoundaryAndClosingADoesNotCancelB() {
        val module = Echo(); engine.register(module)
        val router = router()
        val page = router.open(a); router.open(b)
        ready(router, a, b)
        listOf(a, b).forEach { router.receive(it, request("bridge.hello", "c:hello")) }
        clock.drain(); ackAll(router)
        listOf(a, b).forEach { router.receive(it, request("hold", "c:hold")) }
        clock.drain()
        var cancellations = 0
        module.sessions.forEach { it.onCancel = { cancellations++ } }
        clock.drain()
        router.beginClosing(a)
        assertTrue(page.connection.isClosing)
        router.receive(a, request("hold", "c:blocked"))
        router.receive(a, request("bridge.cancel", "c:cancel", "{\"targetCallbackId\":\"c:hold\"}"))
        clock.drain()
        assertEquals(2, module.sessions.size)
        assertEquals(1, cancellations)
        router.close(a); clock.drain()
        assertEquals(1, engine.connectionCount)
        module.sessions.last().callback(JsonObject().apply { addProperty("live", true) })
        clock.drain()
        assertTrue(sink.frames.last().text.contains("true"))
        assertEquals("B", sink.frames.last().channel)
    }

    @Test fun coreDisconnectSealsOnlyItsOwningRoute() {
        val router = router()
        val first = router.open(a); router.open(b)
        ready(router, a, b)
        router.receive(a, "{broken")
        clock.drain()
        assertTrue(first.isClosed)
        assertFalse(router.contains(a))
        assertTrue(router.contains(b))
        assertEquals(listOf(a), faults)
        assertTrue(sink.disconnected.isEmpty())
        assertFalse(router.receive(a, request("bridge.hello", "again:hello")))
    }

    @Test fun inboundBacklogAdvancesOnePageAtATime() {
        val module = Echo(); engine.register(module)
        val router = router(URNChannelBudget(nativeBatchSize = 1))
        router.open(a); router.open(b)
        ready(router, a, b)
        listOf(a, b).forEach { router.receive(it, request("bridge.hello", "c:hello")) }
        clock.drain(); ackAll(router)
        repeat(4) { router.receive(a, request("hold", "c:a$it", "{\"owner\":\"A\"}")) }
        repeat(2) { router.receive(b, request("hold", "c:b$it", "{\"owner\":\"B\"}")) }
        clock.drain()
        assertEquals(listOf("A", "B", "A", "B"), module.sessions.take(4).map { it.params.get("owner").asString })
    }

    @Test fun reservedPageResultAndEmergencyCloseSurviveFullOrdinaryWindow() {
        val router = router()
        router.open(a); ready(router, a)
        repeat(4) { router.enqueuePageEvent(a, "ordinary$it") }
        clock.drain()
        assertTrue(router.enqueuePageEvent(a, "command failed", control = true))
        clock.drain()
        assertEquals("command failed", sink.frames.last().text)
        router.receive(a, "{bad")
        clock.drain()
        assertEquals(1, faults.size)
        assertEquals(1, sink.frames.count { it.kind == "message" && it.text.contains("bridge.close") })
        assertEquals(1, sink.frames.count { it.kind == "close" })
        assertEquals(4, router.snapshot().inFlight)
        assertEquals(3, router.snapshot().controlMessages)
        ackAll(router)
        assertEquals(0, router.snapshot().controlMessages)
        assertEquals(0, router.snapshot().outboundMessages)
    }

    @Test fun reservedPageResultSlotIsBoundedAndOverflowDisconnectsItsPage() {
        val router = router()
        val page = router.open(a)
        assertTrue(router.enqueuePageEvent(a, "first", control = true))
        assertFalse(router.enqueuePageEvent(a, "second", control = true))
        assertTrue(page.isClosed)
        assertEquals(listOf(a), faults)
        assertTrue(router.snapshot().controlMessages <= 3)
    }

    @Test fun pageAndGlobalUtf8ByteBudgetsIncludeWaitingFrames() {
        val budget = URNChannelBudget(maxFrameBytes = 4, nativePageBytes = 5, nativeBytes = 8)
        val router = router(budget)
        router.open(a); router.open(b)
        assertTrue(router.enqueuePageEvent(a, "你"))
        assertEquals(3L, router.snapshot().outboundBytes)
        assertFalse(router.enqueuePageEvent(a, "你"))
        assertTrue(router.enqueuePageEvent(b, "good"))
        assertEquals(4L, router.snapshot().outboundBytes)
        val other = router(budget.copy(nativePageBytes = 8))
        other.open(a); other.open(b)
        assertTrue(other.enqueuePageEvent(a, "four"))
        assertTrue(other.enqueuePageEvent(b, "four"))
        assertFalse(other.enqueuePageEvent(a, "x"))
        assertTrue(other.contains(b))
    }

    @Test fun inboundUtf8ByteBudgetAndGlobalMessageBudgetAreEnforced() {
        val router = router(URNChannelBudget(maxFrameBytes = 4, nativePageBytes = 5, nativeBytes = 8))
        router.open(a)
        assertTrue(router.receive(a, "你"))
        assertFalse(router.receive(a, "你"))
        clock.drain()
        assertEquals(listOf(a), faults)
        val other = router(URNChannelBudget(nativeMessages = 4, nativePageMessages = 4, nativeBatchSize = 2))
        other.open(a); other.open(b)
        repeat(2) { assertTrue(other.receive(a, "{}")); assertTrue(other.receive(b, "{}")) }
        assertFalse(other.receive(a, "{}"))
        clock.drain()
        assertTrue(other.contains(b))
    }

    @Test fun closingAUnsubscribesOnlyItsOwnRealAerisSubscription() {
        engine.registerEvent("business.changed")
        val router = router()
        router.open(a); router.open(b)
        ready(router, a, b)
        listOf(a, b).forEach { router.receive(it, request("bridge.hello", "c:hello")) }
        clock.drain(); ackAll(router)
        listOf(a, b).forEach { router.receive(it, request("bridge.subscribe", "c:sub", "{\"topic\":\"business.changed\",\"subscriptionId\":\"c:event\"}")) }
        clock.drain(); ackAll(router)
        router.close(a)
        sink.frames.clear()
        engine.publish("business.changed", JsonObject().apply { addProperty("alive", true) })
        clock.drain()
        assertEquals("B", sink.frames.single().channel)
        assertTrue(sink.frames.single().text.contains("c:event"))
        assertEquals(1, engine.connectionCount)
    }

    @Test fun closingWithoutHelloCannotBeReopenedByLateHandshake() {
        val router = router()
        val page = router.open(a)
        ready(router, a)
        router.beginClosing(a)
        router.receive(a, request("bridge.hello", "late:hello"))
        clock.drain()
        assertTrue(page.isClosing)
        assertTrue(sink.frames.single().text.contains("BRIDGE_CLOSING"))
        assertFalse(sink.frames.single().text.contains("\"ready\":true"))
    }

    @Test fun disconnectEndsOnlyTheOldRouterGeneration() {
        val old = router()
        old.open(a)
        old.disconnect("RELOAD", "new runtime")
        assertEquals(listOf("runtime:RELOAD"), sink.disconnected)
        val newer = URNChannelRouter(engine, "new", sink = sink)
        val next = URNAddress("new", "A")
        newer.open(next)
        assertFalse(old.receive(a, "{}"))
        assertFalse(newer.receive(a, "{}"))
        assertTrue(newer.contains(next))
        assertEquals(1, engine.connectionCount)
    }

    @Test fun inboundTransferRemainsBudgetedUntilActualCoreProcessing() {
        val router = router(URNChannelBudget(nativePageMessages = 4, nativeMessages = 4, nativeBatchSize = 2))
        router.open(a)
        repeat(4) { assertTrue(router.receive(a, "{}")) }
        clock.runNext()
        // Inbox 首批已交给真实 Transport，但 Core 的 dispatcher 任务仍未执行。
        assertEquals(4, router.snapshot().inboundMessages)
        assertFalse(router.receive(a, "{}"))
        clock.drain()
        assertEquals(0, router.snapshot().inboundMessages)
        assertEquals(listOf(a), faults)
    }
}
