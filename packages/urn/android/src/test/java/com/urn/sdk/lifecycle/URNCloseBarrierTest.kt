package com.urn.sdk.lifecycle

import com.aeris.sdk.BridgeCancellation
import com.aeris.sdk.BridgeDispatcher
import org.junit.Assert.*
import org.junit.Test
import java.util.PriorityQueue

private class Clock : BridgeDispatcher {
    private data class Task(val due: Long, val id: Long, val action: () -> Unit, var cancelled: Boolean = false)
    private var now = 0L
    private var next = 0L
    private val tasks = PriorityQueue<Task>(compareBy<Task> { it.due }.thenBy { it.id })
    override fun checkThread() = Unit
    override fun execute(action: () -> Unit) { schedule(0, action) }
    override fun schedule(delayMs: Long, action: () -> Unit): BridgeCancellation {
        val task = Task(now + delayMs, ++next, action)
        tasks.add(task)
        return BridgeCancellation { task.cancelled = true }
    }
    fun advance(ms: Long = 0) {
        val end = now + ms
        while (tasks.peek()?.due?.let { it <= end } == true) {
            val task = tasks.remove(); now = task.due
            if (!task.cancelled) task.action()
        }
        now = end
    }
}

class URNCloseBarrierTest {
    @Test fun failedStopRetryDoesNotRequireRepeatingSuccessfulBusinessCleanup() {
        val clock = Clock(); var stops = 0; var released = 0
        val barrier = URNCloseBarrier(clock, 100, {
            stops++
            it(if (stops == 1) Result.failure(IllegalStateException("stop failed")) else Result.success(Unit))
        }, {}, { released++ })
        barrier.disposed(); barrier.cleanupCompleted(Result.success(Unit)); clock.advance()
        assertTrue(barrier.retry())
        assertFalse(barrier.requiresCleanupRetry)
        barrier.continueSurfaceRetry(); clock.advance()
        assertEquals(2, stops); assertEquals(1, released)
    }
    @Test fun failedBusinessCleanupRetryStillRequiresItsOwnConfirmation() {
        val clock = Clock(); var stops = 0
        val barrier = URNCloseBarrier(clock, 100, { stops++; it(Result.success(Unit)) }, {}, {})
        barrier.disposed(); barrier.cleanupCompleted(Result.failure(IllegalStateException("cleanup failed"))); clock.advance()
        assertTrue(barrier.retry()); assertTrue(barrier.requiresCleanupRetry)
        barrier.continueSurfaceRetry(); clock.advance(); assertEquals(0, stops)
        barrier.cleanupCompleted(Result.success(Unit)); clock.advance(); assertEquals(1, stops)
    }
    @Test fun priorFailedSurfaceCallbackCannotSettleNewStopAttempt() {
        val clock = Clock(); var released = 0
        val callbacks = mutableListOf<(Result<Unit>) -> Unit>()
        val barrier = URNCloseBarrier(clock, 100, { callbacks.add(it) }, {}, { released++ })
        barrier.disposed(); barrier.cleanupCompleted(Result.success(Unit)); clock.advance()
        callbacks[0](Result.failure(IllegalStateException("旧停止失败"))); clock.advance()
        assertTrue(barrier.retry())
        barrier.cleanupCompleted(Result.success(Unit)); clock.advance()
        callbacks[0](Result.success(Unit)); clock.advance()
        assertEquals(0, released)
        callbacks[1](Result.success(Unit)); clock.advance()
        assertEquals(1, released)
    }

    @Test fun explicitCleanupRetryReleasesOnlyAfterConfirmedRecovery() {
        val clock = Clock(); var released = 0
        val results = mutableListOf<Result<Unit>>()
        val barrier = URNCloseBarrier(clock, 100, { it(Result.success(Unit)) }, { results.add(it) }, { released++ })
        barrier.disposed()
        barrier.cleanupCompleted(Result.failure(IllegalStateException("业务清理失败")))
        clock.advance()
        assertEquals(0, released)
        assertTrue(barrier.retry())
        barrier.cleanupCompleted(Result.success(Unit))
        clock.advance()
        assertEquals(1, released)
        assertEquals(listOf(false, true), results.map { it.isSuccess })
    }

    @Test fun pendingCleanupAfterTimeoutCannotBeStartedTwice() {
        val clock = Clock()
        val barrier = URNCloseBarrier(clock, 100, { it(Result.success(Unit)) }, {}, {})
        barrier.disposed(); clock.advance(100)
        assertFalse(barrier.retry())
        barrier.cleanupCompleted(Result.success(Unit)); clock.advance()
        assertFalse(barrier.retry())
    }

    @Test fun failedSurfaceStopCanBeRetriedWithoutDuplicatingPendingWork() {
        val clock = Clock(); var stops = 0; var released = 0
        val barrier = URNCloseBarrier(clock, 100, {
            stops++
            it(if (stops == 1) Result.failure(IllegalStateException("停止失败")) else Result.success(Unit))
        }, {}, { released++ })
        barrier.disposed(); barrier.cleanupCompleted(Result.success(Unit)); clock.advance()
        assertEquals(0, released)
        assertTrue(barrier.retry())
        barrier.cleanupCompleted(Result.success(Unit)); clock.advance()
        assertEquals(2, stops); assertEquals(1, released)
    }

    @Test fun timeoutSealsNativeBeforeReportingFailureWithoutClaimingUiReleased() {
        val clock = Clock(); var sealed = false; var released = false; var reported = false
        val barrier = URNCloseBarrier(clock, 100, { it(Result.success(Unit)) }, { outcome ->
            assertTrue(sealed); assertTrue(outcome.isFailure); reported = true
        }, { released = true }, onTimeout = { sealed = true })
        barrier.cleanupCompleted(Result.success(Unit))
        clock.advance(100)
        assertTrue(reported)
        assertFalse(released)
        barrier.disposed(); clock.advance()
        assertTrue(released)
    }

    @Test fun cleanupFailureCannotCancelNativeSealingDeadline() {
        val clock = Clock(); var sealed = false; var released = false
        val results = mutableListOf<Result<Unit>>()
        val barrier = URNCloseBarrier(clock, 100, { it(Result.success(Unit)) }, { results.add(it) },
            { released = true }, onTimeout = { sealed = true })
        barrier.cleanupCompleted(Result.failure(IllegalStateException("cleanup failed")))
        clock.advance()
        assertEquals(1, results.size)
        assertFalse(sealed)
        clock.advance(100)
        assertTrue(sealed)
        assertFalse(released)
        assertEquals(1, results.size)
    }

    @Test fun surfaceStopsOnlyAfterJsAndBusinessCleanupActuallyFinish() {
        val clock = Clock()
        var stopped = 0; var released = 0
        val results = mutableListOf<Result<Unit>>()
        var stopCompletion: ((Result<Unit>) -> Unit)? = null
        val barrier = URNCloseBarrier(clock, 100, {
            stopped++; stopCompletion = it
        }, { results.add(it) }, { released++ })
        barrier.disposed()
        clock.advance()
        assertEquals(0, stopped)
        barrier.cleanupCompleted(Result.success(Unit))
        clock.advance()
        assertEquals(1, stopped)
        assertTrue(results.isEmpty())
        stopCompletion?.invoke(Result.success(Unit))
        clock.advance()
        assertEquals(1, released)
        assertEquals(1, results.size)
        assertTrue(results.single().isSuccess)
    }

    @Test fun timeoutIsFailureAndLateActualCleanupCanReleaseWithoutReportingSuccessTwice() {
        val clock = Clock(); var released = 0
        val results = mutableListOf<Result<Unit>>()
        val barrier = URNCloseBarrier(clock, 100, { it(Result.success(Unit)) }, { results.add(it) }, { released++ })
        barrier.disposed()
        clock.advance(100)
        assertEquals(1, results.size)
        assertTrue(results.single().isFailure)
        assertEquals(0, released)
        barrier.cleanupCompleted(Result.success(Unit))
        clock.advance()
        assertEquals(1, released)
        assertEquals(1, results.size)
    }

    @Test fun duplicateCompletionsDoNotReleaseOrReportTwice() {
        val clock = Clock(); var released = 0
        val results = mutableListOf<Result<Unit>>()
        val barrier = URNCloseBarrier(clock, 100, { completion ->
            completion(Result.success(Unit)); completion(Result.success(Unit))
        }, { results.add(it) }, { released++ })
        repeat(2) { barrier.disposed(); barrier.cleanupCompleted(Result.success(Unit)) }
        clock.advance(1000)
        assertEquals(1, released)
        assertEquals(1, results.size)
        assertTrue(results.single().isSuccess)
    }

    @Test fun cleanupFailureDoesNotStopSurfaceOrClaimResourceRelease() {
        val clock = Clock(); var stopped = 0; var released = 0
        val results = mutableListOf<Result<Unit>>()
        val barrier = URNCloseBarrier(clock, 100, { stopped++ }, { results.add(it) }, { released++ })
        barrier.disposed()
        barrier.cleanupCompleted(Result.failure(IllegalStateException("dismiss failed")))
        barrier.cleanupCompleted(Result.success(Unit))
        clock.advance(1000)
        assertEquals(0, stopped)
        assertEquals(0, released)
        assertEquals(1, results.size)
        assertTrue(results.single().isFailure)
    }

    @Test fun surfaceStopFailureDoesNotReportReleased() {
        val clock = Clock(); var released = 0
        val results = mutableListOf<Result<Unit>>()
        val barrier = URNCloseBarrier(clock, 100, { it(Result.failure(IllegalStateException("surface failed"))) },
            { results.add(it) }, { released++ })
        barrier.disposed(); barrier.cleanupCompleted(Result.success(Unit)); clock.advance(1000)
        assertEquals(0, released)
        assertEquals(1, results.size)
        assertTrue(results.single().isFailure)
    }
}
