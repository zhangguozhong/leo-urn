package com.urn.sdk.lifecycle

import com.aeris.sdk.BridgeCancellation
import com.aeris.sdk.BridgeDispatcher

/** 导航确认与真正离栈分开；取消后迟到的成功必须再次撤销原生页面。 */
internal class URNNavigationTransition(
    private val dispatcher: BridgeDispatcher,
    timeoutMs: Long,
    private val onSuccess: () -> Unit,
    private val onFailure: (String, Throwable?) -> Unit,
    private val onLateSuccess: () -> Unit = {},
) {
    enum class State { PENDING, SUCCEEDED, REJECTED }
    var state = State.PENDING
        private set
    private val deadline: BridgeCancellation = dispatcher.schedule(timeoutMs) {
        reject("NAVIGATION_TIMEOUT")
    }

    fun complete(result: Result<Unit>) = dispatcher.execute {
        when (state) {
            State.PENDING -> {
                deadline.cancel()
                if (result.isSuccess) {
                    state = State.SUCCEEDED
                    onSuccess()
                } else reject("NAVIGATION_FAILED", result.exceptionOrNull())
            }
            State.REJECTED -> if (result.isSuccess) onLateSuccess()
            State.SUCCEEDED -> Unit
        }
    }

    fun cancel() = reject("NAVIGATION_CANCELLED")

    private fun reject(code: String, error: Throwable? = null) {
        if (state != State.PENDING) return
        state = State.REJECTED
        deadline.cancel()
        onFailure(code, error)
    }
}
