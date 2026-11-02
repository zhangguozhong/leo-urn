package com.urn.sdk.lifecycle

import com.aeris.sdk.BridgeCancellation
import com.aeris.sdk.BridgeDispatcher
import org.junit.Assert.*
import org.junit.Test

private class NavigationClock : BridgeDispatcher {
    private data class Task(val due: Long, val action: () -> Unit, var cancelled: Boolean = false)
    private var now = 0L
    private val tasks = mutableListOf<Task>()
    override fun checkThread() = Unit
    override fun execute(action: () -> Unit) { action() }
    override fun schedule(delayMs: Long, action: () -> Unit): BridgeCancellation {
        val task = Task(now + delayMs, action)
        tasks.add(task)
        return BridgeCancellation { task.cancelled = true }
    }
    fun advance(ms: Long) {
        val end = now + ms
        while (true) {
            val task = tasks.filter { !it.cancelled && it.due <= end }.minByOrNull { it.due } ?: break
            tasks.remove(task)
            now = task.due
            task.action()
        }
        now = end
    }
}

class URNNavigationTransitionTest {
    @Test fun successfulConfirmationCancelsDeadlineAndIgnoresDuplicates() {
        val clock = NavigationClock(); var opened = 0; var errors = 0; var late = 0
        val transition = URNNavigationTransition(clock, 100, { opened++ }, { _, _ -> errors++ }, { late++ })
        transition.complete(Result.success(Unit))
        transition.complete(Result.success(Unit))
        clock.advance(1000)
        assertEquals(URNNavigationTransition.State.SUCCEEDED, transition.state)
        assertEquals(1, opened); assertEquals(0, errors); assertEquals(0, late)
    }

    @Test fun cancelledOpenReportsOnceAndLateAttachmentIsCompensated() {
        val clock = NavigationClock(); val errors = mutableListOf<String>(); var closed = 0
        val transition = URNNavigationTransition(clock, 100, { fail("取消后不得确认打开") }, { code, _ -> errors.add(code) }, { closed++ })
        transition.cancel(); transition.cancel()
        clock.advance(1000)
        transition.complete(Result.success(Unit))
        assertEquals(listOf("NAVIGATION_CANCELLED"), errors)
        assertEquals(1, closed)
    }

    @Test fun timeoutRetainsRealRemovalRequirementAndLateSuccessCompensates() {
        val clock = NavigationClock(); val errors = mutableListOf<String>(); var compensated = 0
        val transition = URNNavigationTransition(clock, 100, { fail("超时不能宣布打开成功") }, { code, _ -> errors.add(code) }, { compensated++ })
        clock.advance(100)
        assertEquals(0, compensated)
        assertEquals(listOf("NAVIGATION_TIMEOUT"), errors)
        transition.complete(Result.success(Unit))
        assertEquals(1, compensated)
        assertEquals(1, errors.size)
    }

    @Test fun rejectedTransitionPreservesFailureAndAcceptsLateActualRemoval() {
        val clock = NavigationClock(); var reported: Throwable? = null; var late = 0
        val error = IllegalStateException("宿主拒绝")
        val transition = URNNavigationTransition(clock, 100, { fail("不应成功") }, { _, cause -> reported = cause }, { late++ })
        transition.complete(Result.failure(error))
        transition.complete(Result.failure(error))
        assertSame(error, reported)
        transition.complete(Result.success(Unit))
        assertEquals(1, late)
    }

    @Test fun independentPageAttemptsDoNotCancelEachOther() {
        val clock = NavigationClock(); var firstErrors = 0; var secondOpened = 0
        val first = URNNavigationTransition(clock, 100, {}, { _, _ -> firstErrors++ })
        val second = URNNavigationTransition(clock, 100, { secondOpened++ }, { _, _ -> fail("另一页不得受影响") })
        first.cancel(); second.complete(Result.success(Unit)); clock.advance(100)
        assertEquals(1, firstErrors); assertEquals(1, secondOpened)
    }
}
