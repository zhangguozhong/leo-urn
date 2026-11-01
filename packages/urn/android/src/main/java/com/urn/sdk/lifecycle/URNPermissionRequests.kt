package com.urn.sdk.lifecycle

import java.lang.ref.WeakReference

/** PermissionListener 的 Boolean 表示监听器是否可移除；每个已投递请求码单独取出且只处理一次。 */
internal class URNPermissionRequests<A : Any, L : Any> {
    private data class Request<A : Any, L : Any>(val activity: WeakReference<A>, val listener: L)
    private val requests = mutableMapOf<Int, Request<A, L>>()
    fun put(code: Int, activity: A, listener: L) {
        check(code !in requests) { "权限请求码已经占用" }
        requests[code] = Request(WeakReference(activity), listener)
    }
    fun take(code: Int, activity: A): L? {
        val request = requests.remove(code) ?: return null
        return request.listener.takeIf { request.activity.get() === activity }
    }
    fun remove(code: Int) { requests.remove(code) }
    fun removeActivity(activity: A) { requests.entries.removeAll { it.value.activity.get() === activity } }
    fun clear() { requests.clear() }
}
