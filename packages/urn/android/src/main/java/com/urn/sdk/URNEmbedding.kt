package com.urn.sdk

import android.view.View
import androidx.fragment.app.Fragment

/** 宿主持有owner直到detach成功；失败保留Fragment和page用于retryCleanup。 */
class URNEmbeddedPage
private constructor(
    val page: URNPageHandle,
    private val parent: Fragment,
    private val containerId: Int,
) {
    var ownsBack: Boolean = false
    var error: Throwable? = null
        private set

    private var detaching = false

    fun resize(width: Int, height: Int) {
        require(width in 0..100000 && height in 0..100000)
        check(
            !detaching &&
                page.fragment.id == containerId &&
                parent.view?.findViewById<android.view.ViewGroup>(containerId) != null
        ) {
            "页面不再属于该局部区域"
        }
        page.fragment.view?.let { view ->
            view.layoutParams =
                view.layoutParams.apply {
                    this.width = width
                    this.height = height
                }
        }
    }

    fun setVisible(visible: Boolean) {
        check(!parent.childFragmentManager.isStateSaved) { "宿主正在保存状态" }
        parent.childFragmentManager
            .beginTransaction()
            .apply { if (visible) show(page.fragment) else hide(page.fragment) }
            .commitNow()
        page.fragment.view?.visibility = if (visible) View.VISIBLE else View.GONE
    }

    fun handleBack(): Boolean {
        if (!ownsBack || detaching) return false
        detach()
        return true
    }

    fun detach(completion: (Result<Unit>) -> Unit = {}) {
        if (detaching) {
            completion(Result.failure(IllegalStateException("CLEANUP_BUSY")))
            return
        }
        if (parent.childFragmentManager.isStateSaved) {
            completion(Result.failure(IllegalStateException("宿主正在保存状态，owner仍保留")))
            return
        }
        detaching = true
        val finish: (Result<Unit>) -> Unit = { result ->
            detaching = false
            if (result.isSuccess) {
                runCatching {
                        check(!parent.childFragmentManager.isStateSaved) { "清理期间宿主开始保存状态，重试detach" }
                        parent.childFragmentManager
                            .beginTransaction()
                            .remove(page.fragment)
                            .commitNow()
                    }
                    .also { removed ->
                        error = removed.exceptionOrNull()
                        completion(removed)
                    }
            } else {
                error = result.exceptionOrNull()
                completion(result)
            }
        }
        if (error != null && page.canRetryCleanup) page.retryCleanup(finish) else page.close(finish)
    }

    companion object {
        fun attach(page: URNPageHandle, parent: Fragment, containerId: Int): URNEmbeddedPage {
            check(
                page.state in setOf(URNPageHandle.State.STARTING, URNPageHandle.State.READY) &&
                    !page.fragment.isAdded
            ) {
                "页面已挂载或关闭"
            }
            require(parent.view?.findViewById<android.view.ViewGroup>(containerId) != null) {
                "区域必须属于parent.view"
            }
            check(!parent.childFragmentManager.isStateSaved) { "宿主正在保存状态" }
            parent.childFragmentManager
                .beginTransaction()
                .add(containerId, page.fragment, "urn.embedded.${page.id}")
                .commitNow()
            return URNEmbeddedPage(page, parent, containerId)
        }
    }
}
