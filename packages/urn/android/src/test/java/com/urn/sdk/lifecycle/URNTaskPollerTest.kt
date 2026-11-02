package com.urn.sdk.lifecycle

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class URNTaskPollerTest {
    @Test fun pendingStartsDoNotStarveCompletedSurfaceStop() {
        val done = AtomicBoolean(false)
        val pending = CountDownLatch(2)
        repeat(2) { URNTaskPoller.observe({ done.get() }) { pending.countDown() } }
        val stopped = CountDownLatch(1)
        try {
            URNTaskPoller.observe({ true }) { assertTrue(it.isSuccess); stopped.countDown() }
            assertTrue("未完成的 start 不能阻塞其他 stop", stopped.await(2, TimeUnit.SECONDS))
            assertEquals(2L, pending.count)
        } finally { done.set(true) }
        assertTrue(pending.await(2, TimeUnit.SECONDS))
    }

    @Test fun lateActualCompletionIsStillObservedExactlyOnce() {
        val done = AtomicBoolean(false)
        val firstCheck = CountDownLatch(1)
        val completed = CountDownLatch(1)
        val count = AtomicInteger()
        URNTaskPoller.observe({ firstCheck.countDown(); done.get() }) {
            count.incrementAndGet(); completed.countDown()
        }
        assertTrue(firstCheck.await(2, TimeUnit.SECONDS))
        assertEquals(0, count.get())
        done.set(true)
        assertTrue(completed.await(2, TimeUnit.SECONDS))
        assertEquals(1, count.get())
    }

    @Test fun observationFailureReportsRealErrorInsteadOfClaimingRelease() {
        val completed = CountDownLatch(1)
        val error = IllegalStateException("native task state failed")
        val observed = AtomicReference<Throwable>()
        URNTaskPoller.observe({ throw error }) {
            observed.set(it.exceptionOrNull()); completed.countDown()
        }
        assertTrue(completed.await(2, TimeUnit.SECONDS))
        assertSame(error, observed.get())
    }
}
