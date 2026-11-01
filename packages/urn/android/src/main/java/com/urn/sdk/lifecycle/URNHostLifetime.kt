package com.urn.sdk.lifecycle

/** 只在主 dispatcher 使用；永久退役不可因销毁失败或迟到生命周期回调而撤销。 */
internal class URNHostLifetime {
    var retired = false
        private set

    fun whileActive(action: () -> Unit) {
        if (!retired) action()
    }

    fun retire(invalidate: () -> Unit) {
        if (retired) return
        retired = true
        invalidate()
    }
}
