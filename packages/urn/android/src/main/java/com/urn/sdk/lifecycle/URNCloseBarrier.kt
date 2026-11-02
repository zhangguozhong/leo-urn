package com.urn.sdk.lifecycle

import com.aeris.sdk.BridgeDispatcher
import java.util.concurrent.TimeoutException

/** 取消受理、JS disposed、业务资源释放与 Surface 停止是不同的完成点。 */
internal class URNCloseBarrier(
    private val dispatcher: BridgeDispatcher,
    private val timeoutMs: Long,
    private val stopSurface: ((Result<Unit>) -> Unit) -> Unit,
    private val onCompletion: (Result<Unit>) -> Unit,
    private val onReleased: () -> Unit,
    private val onTimeout: () -> Unit = {},
) {
    private var jsDisposed = false
    private var cleanupSettled = false
    private var cleanupSucceeded = false
    private var stopStarted = false
    private var stopSettled = false
    private var reported = false
    private var released = false
    private var stopSucceeded = false
    private var stopEpoch = 0L
    private var deadline = scheduleDeadline()

    private fun scheduleDeadline() =
        dispatcher.schedule(timeoutMs) {
            runCatching(onTimeout)
            report(Result.failure(TimeoutException("页面清理尚未完成，不能报告资源已经释放")))
        }

    fun disposed() =
        dispatcher.execute {
            jsDisposed = true
            advance()
        }

    fun cleanupCompleted(result: Result<Unit>) =
        dispatcher.execute {
            if (!cleanupSettled) {
                cleanupSettled = true
                cleanupSucceeded = result.isSuccess
                if (result.isFailure) report(result)
            }
            advance()
        }

    private fun advance() {
        if (!jsDisposed || !cleanupSucceeded || stopStarted) return
        stopStarted = true
        val epoch = ++stopEpoch
        try {
            stopSurface { result ->
                dispatcher.execute {
                    if (epoch == stopEpoch && !stopSettled) {
                        stopSettled = true
                        stopSucceeded = result.isSuccess
                        if (result.isSuccess) {
                            released = true
                            deadline.cancel()
                            report(Result.success(Unit))
                            runCatching(onReleased)
                        } else report(result)
                    }
                }
            }
        } catch (error: Exception) {
            stopSettled = true
            report(Result.failure(error))
        }
    }

    val canRetry: Boolean
        get() =
            !released && ((cleanupSettled && !cleanupSucceeded) || (stopSettled && !stopSucceeded))

    val requiresCleanupRetry: Boolean
        get() = !cleanupSucceeded

    /** 宿主登记完成回调后再驱动停止重试，不重复已经成功的业务清理。 */
    fun continueSurfaceRetry() {
        dispatcher.checkThread()
        advance()
    }

    /** 只重试已经明确失败的阶段；超时仍未回调的工作绝不并发重启。 */
    fun retry(): Boolean {
        dispatcher.checkThread()
        val cleanupFailed = cleanupSettled && !cleanupSucceeded
        val stopFailed = stopSettled && !stopSucceeded
        if (released || (!cleanupFailed && !stopFailed)) return false
        deadline.cancel()
        reported = false
        if (cleanupFailed) cleanupSettled = false
        if (stopFailed) {
            stopStarted = false
            stopSettled = false
        }
        deadline = scheduleDeadline()
        // coordinator 在登记 completion 后再通过 cleanupCompleted 驱动 advance。
        return true
    }

    private fun report(result: Result<Unit>) {
        if (reported) return
        reported = true
        runCatching { onCompletion(result) }
    }
}
