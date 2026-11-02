package com.urn.sdk

import androidx.fragment.app.Fragment
import com.google.gson.JsonObject
import com.urn.sdk.routing.URNAddress

data class URNPageResult(val status: String, val data: JsonObject? = null) {
    init {
        require(status == "cancelled" || status == "completed")
        require(data == null || status == "completed")
    }

    companion object {
        fun cancelled() = URNPageResult("cancelled")

        fun completed(data: JsonObject? = null) = URNPageResult("completed", data?.deepCopy())
    }
}

/** 逻辑页面不会因为一次 View 重建更换身份；通信地址每次挂载重新分配。 */
class URNPageHandle
internal constructor(
    val id: String,
    val featureId: String,
    internal val coordinator: URNCoordinator,
) {
    enum class State {
        STARTING,
        READY,
        CLOSING,
        CLOSED,
        FAILED,
    }

    var state = State.STARTING
        internal set

    var error: Throwable? = null
        internal set

    var navigationError: Throwable? = null
        internal set

    var canRetryNavigationClose = false
        internal set

    var canRetry = false
        internal set

    var lifecycle = URNPageLifecycle()
        internal set

    val channelId
        get() = address?.channel

    private var retainedFragment: Fragment? = null
    val fragment: Fragment
        get() = coordinator.fragment(this, retainedFragment).also { retainedFragment = it }

    val address: URNAddress?
        get() = coordinator.address(this)

    val canRetryCleanup: Boolean
        get() = coordinator.requiresCleanupRetry(this)

    val isReady: Boolean
        get() = coordinator.isReady(this)

    fun finish(result: JsonObject? = null) = coordinator.finish(this, result)

    fun retry(completion: (Result<Unit>) -> Unit = {}) = coordinator.retry(this, completion)

    fun retryCleanup(completion: (Result<Unit>) -> Unit = {}) =
        coordinator.retryCleanup(this, completion)

    fun retryNavigationClose() = coordinator.retryNavigationClose(this)

    fun close(completion: (Result<Unit>) -> Unit = {}) =
        coordinator.close(this, completion = completion)
}

interface URNCoordinatorOwner {
    val urnCoordinator: URNCoordinator
}
