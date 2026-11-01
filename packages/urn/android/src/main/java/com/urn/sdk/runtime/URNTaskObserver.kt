package com.urn.sdk.runtime

import com.facebook.react.interfaces.TaskInterface
import com.aeris.sdk.BridgeDispatcher
import com.urn.sdk.lifecycle.URNTaskPoller

/** RN TaskInterface 没有公开 continuation；检查完成标志，避免两个永不完成的 start
 * 占死所有等待线程，令后续 stop 永远无法被观察。超时由拥有者报告，迟到完成仍回传。
 */
internal object URNTaskObserver {
    fun observe(task: TaskInterface<Void>, dispatcher: BridgeDispatcher, completion: (Result<Unit>) -> Unit) {
        URNTaskPoller.observe({ task.isCompleted() }) { polled ->
            val result = polled.mapCatching {
                if (task.isCancelled()) error("RN 原生任务已取消")
                task.getError()?.let { throw it }
                Unit
            }
            dispatcher.execute { completion(result) }
        }
    }
}
