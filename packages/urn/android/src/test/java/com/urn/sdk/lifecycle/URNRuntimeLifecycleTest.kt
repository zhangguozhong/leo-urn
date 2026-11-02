package com.urn.sdk.lifecycle

import org.junit.Assert.*
import org.junit.Test

class URNRuntimeLifecycleTest {
    private val lifecycle = URNRuntimeLifecycle()

    private fun running(generation: String = "first") {
        lifecycle.starting()
        assertTrue(lifecycle.bootstrap(generation))
        assertTrue(lifecycle.boot(generation))
        assertEquals(URNRuntimeLifecycle.State.RUNNING, lifecycle.state)
    }

    @Test fun idleCannotBootAndOnlyExpectedGenerationCanCompleteStartup() {
        assertEquals(URNRuntimeLifecycle.State.IDLE, lifecycle.state)
        assertFalse(lifecycle.bootstrap("unsolicited"))
        assertFalse(lifecycle.boot("unsolicited"))
        assertFalse(lifecycle.beginReload())
        lifecycle.starting()
        assertEquals(URNRuntimeLifecycle.State.STARTING, lifecycle.state)
        assertFalse(lifecycle.boot("first"))
        assertTrue(lifecycle.bootstrap("first"))
        assertFalse(lifecycle.boot("wrong"))
        assertEquals(URNRuntimeLifecycle.State.STARTING, lifecycle.state)
        assertTrue(lifecycle.boot("first"))
        assertEquals(URNRuntimeLifecycle.State.RUNNING, lifecycle.state)
    }

    @Test fun stoppingImmediatelyAfterStartingRejectsLateBootAndBootstrap() {
        lifecycle.starting()
        assertTrue(lifecycle.bootstrap("first"))
        lifecycle.stopping()
        assertFalse(lifecycle.boot("first"))
        assertFalse(lifecycle.bootstrap("second"))
        lifecycle.modulesLost()
        assertFalse(lifecycle.beginReload())
        assertEquals(URNRuntimeLifecycle.State.STOPPING, lifecycle.state)
    }

    @Test fun reloadPreservesItsStateUntilNewBootstrapAndNewBootArrive() {
        running()
        assertTrue(lifecycle.beginReload())
        assertFalse(lifecycle.beginReload())
        assertEquals(URNRuntimeLifecycle.State.RELOADING, lifecycle.state)
        assertFalse(lifecycle.boot("first"))
        lifecycle.starting(reload = true)
        assertEquals(URNRuntimeLifecycle.State.RELOADING, lifecycle.state)
        assertFalse(lifecycle.bootstrap("first"))
        assertFalse(lifecycle.boot("first"))
        assertFalse(lifecycle.boot("second"))
        assertTrue(lifecycle.bootstrap("second"))
        assertFalse(lifecycle.boot("first"))
        assertTrue(lifecycle.boot("second"))
        assertEquals(URNRuntimeLifecycle.State.RUNNING, lifecycle.state)
    }

    @Test fun duplicateBootAndBootstrapCannotRepeatRuntimeTransition() {
        lifecycle.starting()
        assertTrue(lifecycle.bootstrap("first"))
        assertFalse(lifecycle.bootstrap("first"))
        assertEquals(URNRuntimeLifecycle.State.STARTING, lifecycle.state)
        assertTrue(lifecycle.boot("first"))
        repeat(2) {
            assertFalse(lifecycle.boot("first"))
            assertFalse(lifecycle.bootstrap("first"))
        }
        assertEquals(URNRuntimeLifecycle.State.RUNNING, lifecycle.state)
    }

    @Test fun modulesLostBlocksOldVmAndWaitsForAReplacementVm() {
        running()
        lifecycle.modulesLost()
        lifecycle.modulesLost()
        assertEquals(URNRuntimeLifecycle.State.RELOADING, lifecycle.state)
        assertFalse(lifecycle.boot("first"))
        assertFalse(lifecycle.bootstrap("first"))
        assertTrue(lifecycle.bootstrap("second"))
        assertTrue(lifecycle.boot("second"))
        assertEquals(URNRuntimeLifecycle.State.RUNNING, lifecycle.state)
    }

    @Test fun failedRuntimeRejectsLateBootBootstrapReloadAndModuleLoss() {
        lifecycle.starting()
        assertTrue(lifecycle.bootstrap("first"))
        lifecycle.failed()
        assertFalse(lifecycle.boot("first"))
        assertFalse(lifecycle.bootstrap("second"))
        assertFalse(lifecycle.beginReload())
        lifecycle.modulesLost()
        assertEquals(URNRuntimeLifecycle.State.FAILED, lifecycle.state)
    }

    @Test fun startingAgainDiscardsExpectedGenerationFromPreviousAttempt() {
        lifecycle.starting()
        assertTrue(lifecycle.bootstrap("first"))
        lifecycle.starting()
        assertEquals(URNRuntimeLifecycle.State.STARTING, lifecycle.state)
        assertFalse(lifecycle.boot("first"))
        assertFalse(lifecycle.bootstrap("first"))
        assertTrue(lifecycle.bootstrap("second"))
        assertTrue(lifecycle.boot("second"))
    }

    @Test fun destroyedResetsStateAndGenerationHistoryForExplicitNewRuntime() {
        running()
        lifecycle.stopping()
        lifecycle.destroyed()
        assertEquals(URNRuntimeLifecycle.State.IDLE, lifecycle.state)
        assertFalse(lifecycle.boot("first"))
        lifecycle.modulesLost()
        assertEquals(URNRuntimeLifecycle.State.IDLE, lifecycle.state)
        running()
    }

    @Test fun allRetiredGenerationsStayBlockedAcrossSuccessiveReloads() {
        running()
        assertTrue(lifecycle.beginReload())
        assertTrue(lifecycle.bootstrap("second"))
        assertTrue(lifecycle.boot("second"))
        assertTrue(lifecycle.beginReload())
        assertFalse(lifecycle.bootstrap("first"))
        assertFalse(lifecycle.bootstrap("second"))
        assertTrue(lifecycle.bootstrap("third"))
        assertFalse(lifecycle.boot("first"))
        assertFalse(lifecycle.boot("second"))
        assertTrue(lifecycle.boot("third"))
    }

    @Test fun moduleLossDuringStartupRequiresFreshBootstrap() {
        lifecycle.starting()
        assertTrue(lifecycle.bootstrap("first"))
        lifecycle.modulesLost()
        assertEquals(URNRuntimeLifecycle.State.RELOADING, lifecycle.state)
        assertFalse(lifecycle.boot("first"))
        assertTrue(lifecycle.bootstrap("second"))
        assertTrue(lifecycle.boot("second"))
    }
}
