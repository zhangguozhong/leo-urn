package com.urn.sdk.lifecycle

import org.junit.Assert.*
import org.junit.Test

class URNHostLifetimeTest {
    @Test fun retirementBlocksReentrantAndLateLifecycleEvents() {
        val lifetime = URNHostLifetime()
        val calls = mutableListOf<String>()
        lifetime.whileActive { calls.add("resume") }
        lifetime.retire {
            calls.add("invalidate")
            lifetime.whileActive { calls.add("reentrant-pause") }
        }
        lifetime.whileActive { calls.add("late-destroy") }
        lifetime.retire { calls.add("duplicate-invalidate") }
        assertTrue(lifetime.retired)
        assertEquals(listOf("resume", "invalidate"), calls)
    }

    @Test fun retirementFailureNeverReactivatesTheOldHost() {
        val lifetime = URNHostLifetime()
        assertThrows(IllegalStateException::class.java) {
            lifetime.retire { error("原生销毁失败") }
        }
        var calls = 0
        lifetime.whileActive { calls++ }
        lifetime.retire { calls++ }
        assertTrue(lifetime.retired)
        assertEquals(0, calls)
    }
}
