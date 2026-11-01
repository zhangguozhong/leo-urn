package com.urn.sdk

import androidx.fragment.app.Fragment

class URNContainerException(val code: String, message: String, cause: Throwable? = null) :
    IllegalStateException(message, cause)

enum class URNPagePresentation { PUSH, PRESENT }

/** 成功仅表示实际提交完成；宿主自定义异步导航须在转场确认后回调。 */
interface URNPageNavigating {
    fun open(page: URNPageHandle, from: Fragment, presentation: URNPagePresentation, completion: (Result<Unit>) -> Unit)
    fun close(page: URNPageHandle, completion: (Result<Unit>) -> Unit)
}

/** push 使用来源容器，present 使用独立 DialogFragment。
 * add/hide 保留前一页连接，FragmentManager/OnBackPressedDispatcher 负责返回及其取消。
 */
class URNFragmentNavigator : URNPageNavigating {
    override fun open(page: URNPageHandle, from: Fragment, presentation: URNPagePresentation, completion: (Result<Unit>) -> Unit) {
        completion(runCatching {
            val manager = from.parentFragmentManager
            check(!manager.isStateSaved && from.isAdded && from.id != 0 && !from.isHidden) { "来源页面不在可导航容器内" }
            when (presentation) {
                URNPagePresentation.PUSH -> {
                    manager.beginTransaction().setReorderingAllowed(true)
                        .hide(from).add(from.id, page.fragment, tag(page))
                        .addToBackStack(tag(page)).commit()
                    manager.executePendingTransactions()
                }
                URNPagePresentation.PRESENT -> {
                    manager.beginTransaction().hide(from).commitNow()
                    try { URNModalFragment.create(page.id, from.tag, (from as? URNFragment)?.pageId).showNow(manager, "urn.modal.${page.id}") }
                    catch (error: Exception) {
                        manager.beginTransaction().show(from).commitNow()
                        throw error
                    }
                }
            }
            check(page.fragment.isAdded) { "目标页面未挂载" }
        })
    }

    override fun close(page: URNPageHandle, completion: (Result<Unit>) -> Unit) {
        completion(runCatching {
            val fragment = page.fragment
            if (!fragment.isAdded) return@runCatching
            val modal = fragment.parentFragment as? URNModalFragment
            if (modal != null && modal.childFragmentManager.backStackEntryCount == 0) {
                check(!modal.parentFragmentManager.isStateSaved) { "宿主已经保存导航状态" }
                modal.dismissNow()
                check(!fragment.isAdded) { "模态页面仍在原生栈内" }
                return@runCatching
            }
            val manager = fragment.parentFragmentManager
            check(!manager.isStateSaved) { "宿主已经保存导航状态" }
            val top = manager.backStackEntryCount.takeIf { it > 0 }?.let { manager.getBackStackEntryAt(it - 1).name }
            if (top != tag(page)) throw URNContainerException("NAVIGATION_UNAVAILABLE", "只能关闭默认导航栈顶页面，根页面需由宿主处理")
            check(manager.popBackStackImmediate()) { "原生导航未完成移除" }
            check(!fragment.isAdded) { "页面仍在原生栈内" }
        })
    }

    private fun tag(page: URNPageHandle) = "urn.navigation.${page.id}"
}
