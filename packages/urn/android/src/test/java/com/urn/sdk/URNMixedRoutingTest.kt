package com.urn.sdk

import androidx.fragment.app.Fragment
import com.aeris.sdk.BridgeCancellation
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.*
import org.junit.Test

/** 使用真实路由事务与显式UI owner；只替代主线程时钟，不伪造cleanup完成。 */
class URNMixedRoutingTest {
    private fun router(config: URNMixedRouting, clock: () -> Long = System::currentTimeMillis) =
        URNMixedRouter(config, { _, _ -> BridgeCancellation {} }, { it() }, { true }, clock = clock)

    @Test
    fun cancelledLateOwnerReuseFinishesFailureAndNeverClosesOriginalOwner() {
        var calls = 0
        var closed = 0
        val owner =
            URNRouteOwner(
                "shared",
                close = {
                    closed++
                    it(Result.success(Unit))
                },
            )
        lateinit var reply: (Result<URNRouteOwner>) -> Unit
        val routing =
            router(
                URNMixedRouting(
                    mapOf("/x" to URNRouteTarget.Native("x")),
                    dispatch = { _, _, _, done ->
                        if (++calls == 1) done(Result.success(owner)) else reply = done
                        URNRouteOperation { it(Result.success(Unit)) }
                    },
                )
            )
        routing.open("/x", JsonObject(), "a", Fragment()) {}
        val pending = routing.open("/x", JsonObject(), "b", Fragment()) {}
        var cancelled: Result<Unit>? = null
        pending.cancel { cancelled = it }
        reply(Result.success(owner))
        assertEquals("OWNER_REUSED", (cancelled?.exceptionOrNull() as? URNContainerException)?.code)
        assertEquals(0, closed)
    }

    @Test
    fun ownersWithSameDisplayIdKeepSeparateSourcesAndCleanupBarriers() {
        val pending = mutableMapOf<String, (Result<Unit>) -> Unit>()
        val calls = mutableListOf<String>()
        val routing =
            router(
                URNMixedRouting(
                    mapOf("/x" to URNRouteTarget.Native("broken")),
                    dispatch = { target, params, _, done ->
                        if (target == URNRouteTarget.Native("broken"))
                            done(Result.failure(IllegalStateException("runtime")))
                        else {
                            val source = params.get("source").asString
                            done(
                                Result.success(
                                    URNRouteOwner(
                                        "shared",
                                        close = {
                                            pending[source] = it
                                            calls.add(source)
                                        },
                                    )
                                )
                            )
                        }
                        URNRouteOperation { it(Result.success(Unit)) }
                    },
                    fallback = { _, _, done -> done(URNRouteTarget.Native("error")) },
                )
            )
        for (source in listOf("a", "b")) routing.open(
            "/x",
            JsonObject().apply { addProperty("source", source) },
            source,
            Fragment(),
        ) {}
        var a: Result<Unit>? = null
        var b: Result<Unit>? = null
        routing.invalidate("a") { a = it }
        routing.invalidate("b") { b = it }
        assertEquals(setOf("a", "b"), calls.toSet())
        assertNull(a)
        assertNull(b)
        pending.getValue("a")(Result.failure(IllegalStateException("cleanup a")))
        pending.getValue("b")(Result.success(Unit))
        assertTrue(a?.isFailure == true)
        assertTrue(b?.isSuccess == true)
        assertEquals(1, routing.pendingCleanupCount)
        var retried = false
        routing.retryCleanup("a") { retried = it.isSuccess }
        pending.getValue("a")(Result.success(Unit))
        assertTrue(retried)
        assertEquals(listOf("a", "b", "a"), calls)
        assertEquals(0, routing.pendingCleanupCount)
    }

    @Test
    fun captureRejectsCrossDomainAndUnboundOwnersWithoutRelabelingThem() {
        val routing =
            router(
                URNMixedRouting(
                    mapOf("/x" to URNRouteTarget.Native("x")),
                    dispatch = { _, _, _, done ->
                        done(
                            Result.success(
                                URNRouteOwner(
                                    "shared",
                                    close = { it(Result.success(Unit)) },
                                    capture = {
                                        it(
                                            Result.success(
                                                JsonObject().apply { addProperty("account", "A") }
                                            )
                                        )
                                    },
                                )
                            )
                        )
                        URNRouteOperation { it(Result.success(Unit)) }
                    },
                )
            )
        routing.setDomain("A")
        var owner: URNRouteOwner? = null
        routing.open("/x", JsonObject(), "a", Fragment()) { owner = it.getOrThrow() }
        routing.setDomain("B")
        var captured: Result<String>? = null
        routing.capture(listOf(URNRestorableRoute("/x", owner = checkNotNull(owner))), "base", "") {
            captured = it
        }
        assertEquals(
            "SNAPSHOT_OWNER_DOMAIN_MISMATCH",
            (captured?.exceptionOrNull() as? URNContainerException)?.code,
        )
        val external = URNRouteOwner("shared", close = { it(Result.success(Unit)) })
        routing.capture(listOf(URNRestorableRoute("/x", owner = external)), "base", "") {
            captured = it
        }
        assertEquals(
            "SNAPSHOT_OWNER_UNBOUND",
            (captured?.exceptionOrNull() as? URNContainerException)?.code,
        )
        routing.registerRestorationOwner(external, "B", "/x")
        assertThrows(URNContainerException::class.java) {
            routing.registerRestorationOwner(external, "A", "/x")
        }
        routing.capture(listOf(URNRestorableRoute("/x", owner = external)), "base", "") {
            captured = it
        }
        assertEquals(
            "B",
            JsonParser.parseString(checkNotNull(captured).getOrThrow())
                .asJsonObject
                .get("userDomain")
                .asString,
        )
    }

    @Test
    fun failureHistoryIsBoundedAndCircuitRejectionDoesNotExtendCooldown() {
        var now = 100000L
        var attempts = 0
        val routing =
            router(
                URNMixedRouting(
                    mapOf("/x" to URNRouteTarget.Native("x")),
                    failureLimit = 3,
                    cooldownMs = 1,
                    dispatch = { _, _, _, done ->
                        attempts++
                        done(Result.failure(IllegalStateException("runtime")))
                        URNRouteOperation { it(Result.success(Unit)) }
                    },
                ),
                clock = { now },
            )
        repeat(50) {
            now += 2
            routing.open("/x", JsonObject(), "a", Fragment()) {}
        }
        val failuresField =
            routing.javaClass.getDeclaredField("failures").apply { isAccessible = true }
        val failures = failuresField.get(routing) as Map<*, *>
        assertEquals(1, failures.size)
        assertTrue(failures.values.all { (it as List<*>).size <= 3 })
        val blockedField =
            routing.javaClass.getDeclaredField("blockedUntil").apply { isAccessible = true }
        val blocked = blockedField.get(routing) as Map<*, *>
        val deadline = blocked.values.single()
        repeat(20) { routing.open("/x", JsonObject(), "a", Fragment()) {} }
        assertEquals(deadline, blocked.values.single())
        assertEquals(50, attempts)
    }

    @Test
    fun synchronousDispatcherCloseWaitsUntilReturnedOperationAndLateOwnerCleanup() {
        lateinit var routing: URNMixedRouter
        lateinit var reply: (Result<URNRouteOwner>) -> Unit
        lateinit var cleanup: (Result<Unit>) -> Unit
        var closeResult: Result<Unit>? = null
        routing =
            router(
                URNMixedRouting(
                    mapOf("/x" to URNRouteTarget.Native("x")),
                    dispatch = { _, _, _, done ->
                        routing.invalidate("a") { closeResult = it }
                        reply = done
                        URNRouteOperation { it(Result.success(Unit)) }
                    },
                )
            )
        var cancelled = false
        routing.open("/x", JsonObject(), "a", Fragment()) { cancelled = it.isFailure }
        assertTrue(cancelled)
        assertNull(closeResult)
        reply(Result.success(URNRouteOwner("created-before-close", close = { cleanup = it })))
        assertNull(closeResult)
        cleanup(Result.success(Unit))
        assertTrue(closeResult?.isSuccess == true)
    }

    @Test
    fun sequentialCancellationReplaysTheSameTerminalResult() {
        val routing =
            router(
                URNMixedRouting(
                    mapOf("/x" to URNRouteTarget.Native("x")),
                    guard = { _, _, _ -> },
                    dispatch = { _, _, _, _ -> error("cancelled guard must not dispatch") },
                )
            )
        val operation = routing.open("/x", JsonObject(), "a", Fragment()) {}
        var callbacks = 0
        operation.cancel {
            assertTrue(it.isSuccess)
            callbacks++
        }
        operation.cancel {
            assertTrue(it.isSuccess)
            callbacks++
        }
        assertEquals(2, callbacks)
    }

    @Test
    fun fallbackCleanupRemainsScopedAndInvalidationWaitsForRealOwner() {
        lateinit var finishCleanup: (Result<Unit>) -> Unit
        var cleaned = 0
        val routing =
            router(
                URNMixedRouting(
                    mapOf("/x" to URNRouteTarget.Native("broken")),
                    dispatch = { target, _, _, done ->
                        if (target == URNRouteTarget.Native("broken"))
                            done(Result.failure(IllegalStateException("failure")))
                        else
                            done(
                                Result.success(
                                    URNRouteOwner(
                                        "fallback",
                                        close = {
                                            finishCleanup = it
                                            cleaned++
                                        },
                                    )
                                )
                            )
                        URNRouteOperation { it(Result.success(Unit)) }
                    },
                    fallback = { _, _, done -> done(URNRouteTarget.Native("error")) },
                )
            )
        var failed = false
        routing.open("demo://app/x", JsonObject(), "a", Fragment()) { failed = it.isFailure }
        assertTrue(failed)
        assertEquals(1, routing.pendingCleanupCount)
        var unrelated = false
        routing.invalidate("b") { unrelated = it.isSuccess }
        assertTrue(unrelated)
        assertEquals(0, cleaned)
        var completed = false
        routing.invalidate("a") { completed = it.isSuccess }
        assertEquals(1, cleaned)
        assertFalse(completed)
        finishCleanup(Result.success(Unit))
        assertTrue(completed)
        assertEquals(0, routing.pendingCleanupCount)
    }

    @Test
    fun cancellationAwaitsLateMountedOwnerAndPreservesCleanupFailure() {
        lateinit var dispatched: (Result<URNRouteOwner>) -> Unit
        lateinit var cleaned: (Result<Unit>) -> Unit
        val routing =
            router(
                URNMixedRouting(
                    mapOf("/x" to URNRouteTarget.Native("x")),
                    dispatch = { _, _, _, done ->
                        dispatched = done
                        URNRouteOperation { it(Result.success(Unit)) }
                    },
                )
            )
        var failed = false
        val operation = routing.open("/x", JsonObject(), "a", Fragment()) { failed = it.isFailure }
        var cancellation: Result<Unit>? = null
        operation.cancel { cancellation = it }
        assertTrue(failed)
        assertNull(cancellation)
        dispatched(Result.success(URNRouteOwner("late", close = { cleaned = it })))
        assertNull(cancellation)
        cleaned(Result.failure(IllegalStateException("cleanup")))
        assertTrue(cancellation?.isFailure == true)
        assertEquals(1, routing.pendingCleanupCount)
        var retried = false
        routing.retryCleanup { retried = it.isSuccess }
        cleaned(Result.success(Unit))
        assertTrue(retried)
        assertEquals(0, routing.pendingCleanupCount)
    }

    @Test
    fun closingSourceCancelsReadBeforeItCompletesAndLateReadCannotDispatch() {
        var dispatches = 0
        val routing =
            router(
                URNMixedRouting(
                    mapOf("/x" to URNRouteTarget.Native("x")),
                    dispatch = { _, _, _, done ->
                        dispatches++
                        done(Result.failure(IllegalStateException("must not open")))
                        URNRouteOperation { it(Result.success(Unit)) }
                    },
                )
            )
        lateinit var read: (Result<String>) -> Unit
        var restored: Result<List<URNRouteOwner>>? = null
        routing.restore({ read = it }, "base", "", Fragment(), "a") { restored = it }
        var closeDone = false
        routing.invalidate("a") { closeDone = it.isSuccess }
        assertTrue(closeDone)
        assertTrue(restored?.isFailure == true)
        read(
            Result.success(
                """{"version":1,"baselineId":"base","modules":"","userDomain":"anonymous","pages":[{"route":"/x","params":{},"state":null}]}"""
            )
        )
        assertEquals(0, dispatches)
    }

    @Test
    fun stateApplyFailureRollsBackOnlyNewOwnersAndWaitsForCleanup() {
        val created = mutableListOf<String>()
        val closed = mutableListOf<String>()
        lateinit var finish: (Result<Unit>) -> Unit
        val routing =
            router(
                URNMixedRouting(
                    mapOf("/x" to URNRouteTarget.Native("x")),
                    dispatch = { _, _, _, done ->
                        val id = "new-${created.size}"
                        created.add(id)
                        done(
                            Result.success(
                                URNRouteOwner(
                                    id,
                                    close = {
                                        closed.add(id)
                                        finish = it
                                    },
                                    restore = { _, applied ->
                                        applied(Result.failure(IllegalStateException("apply")))
                                    },
                                )
                            )
                        )
                        URNRouteOperation { it(Result.success(Unit)) }
                    },
                )
            )
        var restored: Result<List<URNRouteOwner>>? = null
        val json =
            """{"version":1,"baselineId":"base","modules":"","userDomain":"anonymous","pages":[{"route":"/x","params":{},"state":null}]}"""
        routing.restore({ it(Result.success(json)) }, "base", "", Fragment(), "a") { restored = it }
        assertEquals(listOf("new-0"), closed)
        assertNull(restored)
        finish(Result.failure(IllegalStateException("cleanup")))
        assertEquals(
            "RESTORE_ROLLBACK_FAILED",
            (restored?.exceptionOrNull() as? URNContainerException)?.code,
        )
        assertEquals(1, routing.pendingCleanupCount)
    }
}
