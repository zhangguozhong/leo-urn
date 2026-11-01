package com.urn.sdk.lifecycle

import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** 完成状态检查不会为未完成任务独占线程；并行页面的停止仍可被观察。 */
internal object URNTaskPoller {
    private val workers = Executors.newScheduledThreadPool(2) { work ->
        Thread(work, "URN-native-task").apply { isDaemon = true }
    }
    fun observe(isCompleted: () -> Boolean, completion: (Result<Unit>) -> Unit) {
        fun poll() {
            val completed = runCatching(isCompleted)
            if (completed.getOrNull() == false) {
                workers.schedule({ poll() }, 10, TimeUnit.MILLISECONDS)
                return
            }
            completion(completed.map { Unit })
        }
        workers.execute { poll() }
    }
}
