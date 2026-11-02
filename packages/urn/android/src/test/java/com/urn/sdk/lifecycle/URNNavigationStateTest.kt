package com.urn.sdk.lifecycle

import org.junit.Assert.*
import org.junit.Test

class URNNavigationStateTest {
    @Test fun reloadIsBusyUntilOpenOrCloseReallySettles() {
        val state = URNNavigationState()
        val open = state.beginOpen()
        assertTrue(state.busy)
        state.opened(open)
        assertFalse(state.busy)
        val close = state.beginClose()
        assertFalse(state.acceptsWork)
        state.closeFailed(close)
        assertTrue(state.busy)
        assertFalse(state.acceptsWork)
        state.closed(state.beginClose())
        assertFalse(state.busy)
    }
    @Test fun previousEpochCannotMutateRemountedNavigationState() {
        val state = URNNavigationState()
        val old = state.beginOpen()
        state.rotate()
        val current = state.beginClose()
        state.opened(old); state.closeFailed(old)
        assertTrue(state.matches(current)); assertFalse(state.matches(old))
        assertTrue(state.busy); assertFalse(state.acceptsWork)
    }
    @Test fun staleNativeTransitionCompletionCannotReachTheNewMount() {
        val dispatcher = object : com.aeris.sdk.BridgeDispatcher {
            override fun checkThread() = Unit
            override fun execute(action: () -> Unit) = action()
            override fun schedule(delayMs: Long, action: () -> Unit) = com.aeris.sdk.BridgeCancellation {}
        }
        val state = URNNavigationState(); val old = state.beginOpen(); var delivered = 0
        val transition = URNNavigationTransition(dispatcher, 100, onSuccess = {
            if (!state.matches(old)) return@URNNavigationTransition
            state.opened(old); delivered++
        }, onFailure = { _, _ -> fail("不能报告旧轮次错误") })
        state.rotate()
        transition.complete(Result.success(Unit))
        assertEquals(0, delivered)
        assertFalse(state.busy)
    }
    @Test fun permissionResultRetiresItsRequestEvenWhenListenerStillHasOtherWork() {
        val requests = URNPermissionRequests<Any, Any>()
        val activity = Any(); val listener = Any()
        requests.put(1, activity, listener); requests.put(2, activity, listener)
        assertSame(listener, requests.take(1, activity))
        requests.put(1, activity, listener) // request 1 is reusable before the shared listener's final result.
        assertSame(listener, requests.take(2, activity))
        assertNull(requests.take(2, activity))
        requests.removeActivity(activity)
        assertNull(requests.take(1, activity))
    }
    @Test fun permissionCannotBeDeliveredToReplacementActivity() {
        val requests = URNPermissionRequests<Any, Any>()
        val original = Any(); val replacement = Any()
        requests.put(3, original, Any())
        assertNull(requests.take(3, replacement))
        requests.put(3, replacement, Any())
        requests.clear()
        assertNull(requests.take(3, replacement))
    }
}
