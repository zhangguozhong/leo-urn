package com.urn.sdk.lifecycle

/** Record 会跨 Reload 保留；导航回调必须额外匹配当前挂载轮次。 */
internal class URNNavigationState {
    private var epoch = 0L
    private var opening = false
    private var closing = false
    private var recoveryFailed = false
    val busy get() = opening || closing || recoveryFailed
    val acceptsWork get() = !closing && !recoveryFailed
    fun matches(ticket: Long) = epoch == ticket
    fun beginOpen(): Long { opening = true; return epoch }
    fun opened(ticket: Long) { if (matches(ticket)) opening = false }
    fun beginClose(): Long { closing = true; recoveryFailed = false; return epoch }
    fun closeFailed(ticket: Long) { if (matches(ticket)) { closing = false; recoveryFailed = true } }
    fun closed(ticket: Long) { if (matches(ticket)) { closing = false; recoveryFailed = false } }
    fun rotate() { epoch++; opening = false; closing = false; recoveryFailed = false }
}
