package com.urn.sdk.lifecycle

/** 由 Coordinator 在串行 dispatcher 上直接驱动；启动确认必须属于当前实际 VM 轮次。 */
internal class URNRuntimeLifecycle {
    enum class State { IDLE, STARTING, RUNNING, RELOADING, STOPPING, FAILED }
    var state: State = State.IDLE
        private set

    private var expectedGeneration: String? = null
    private val blockedGenerations = mutableSetOf<String>()

    fun starting(reload: Boolean = false) {
        retireExpectedGeneration()
        state = if (reload) State.RELOADING else State.STARTING
    }

    fun bootstrap(generation: String): Boolean {
        if (!isStarting() || generation.isEmpty() || generation == expectedGeneration || generation in blockedGenerations) return false
        // 新 VM 可能在上次 boot 到达前已创建；上一轮确认仍必须永久失效。
        retireExpectedGeneration()
        expectedGeneration = generation
        return true
    }

    fun boot(generation: String): Boolean {
        if (!isStarting() || generation != expectedGeneration || generation in blockedGenerations) return false
        state = State.RUNNING
        return true
    }

    fun beginReload(): Boolean {
        if (state != State.RUNNING) return false
        retireExpectedGeneration()
        state = State.RELOADING
        return true
    }

    fun modulesLost() {
        if (state != State.RUNNING && !isStarting()) return
        retireExpectedGeneration()
        state = State.RELOADING
    }

    fun stopping() { state = State.STOPPING }
    fun failed() { state = State.FAILED }
    fun destroyed() {
        state = State.IDLE
        expectedGeneration = null
        blockedGenerations.clear()
    }

    private fun isStarting(): Boolean = state == State.STARTING || state == State.RELOADING
    private fun retireExpectedGeneration() {
        expectedGeneration?.let { blockedGenerations.add(it) }
        expectedGeneration = null
    }
}
