package com.urn.sdk

import android.app.Dialog
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.ComponentDialog
import androidx.activity.OnBackPressedCallback
import androidx.fragment.app.DialogFragment
import androidx.fragment.app.FragmentManager

/** present 的独立模态容器。来源只隐藏，模态确认离栈时才恢复来源及关闭子页。 */
class URNModalFragment : DialogFragment(), URNCoordinatorOwner {
    override val urnCoordinator: URNCoordinator
        get() = (parentFragment as? URNCoordinatorOwner)?.urnCoordinator
            ?: (activity as? URNCoordinatorOwner)?.urnCoordinator
            ?: (activity?.application as? URNCoordinatorOwner)?.urnCoordinator
            ?: error("宿主没有 URNCoordinator")
    private var containerId = 0
    private val pageId get() = arguments?.getString("urn.modal.pageId")
    private val sourceTag get() = arguments?.getString("urn.modal.sourceTag")
    private val sourcePageId get() = arguments?.getString("urn.modal.sourcePageId")
    private var modalBack: OnBackPressedCallback? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        containerId = savedInstanceState?.getInt("urn.modal.containerId")?.takeIf { it != 0 } ?: View.generateViewId()
    }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putInt("urn.modal.containerId", containerId)
        super.onSaveInstanceState(outState)
    }
    override fun onCreateDialog(savedInstanceState: Bundle?): Dialog = ComponentDialog(requireContext(), theme)
    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View =
        FrameLayout(requireContext()).apply { id = containerId }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val page = pageId?.let { urnCoordinator.page(it) }
        if (page == null) {
            (view as FrameLayout).addView(TextView(requireContext()).apply { text = "URN 页面已失效，请由宿主重新打开" })
            return
        }
        if (childFragmentManager.fragments.isEmpty()) {
            childFragmentManager.beginTransaction().setReorderingAllowed(true)
                .add(containerId, page.fragment, "urn.modal.root.${page.id}").commitNow()
        }
    }
    override fun onStart() {
        super.onStart()
        dialog?.window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        val componentDialog = dialog as? ComponentDialog ?: return
        val callback = object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // 预测返回开始/进度/取消不改变栈；仅系统提交时才执行 pop 或 dismiss。
                if (!urnCoordinator.onBackPressed()) invokeDefaultBackPressed()
            }
        }
        modalBack?.remove()
        modalBack = callback
        componentDialog.onBackPressedDispatcher.addCallback(this, callback)
    }
    /** JS BackHandler 未处理返回提交时，RN 异步调用 Activity 的默认返回处理器。 */
    private fun invokeDefaultBackPressed() {
        if (childFragmentManager.isStateSaved || parentFragmentManager.isStateSaved) return
        if (dispatchDefaultBack(childFragmentManager)) return
        if (childFragmentManager.backStackEntryCount > 0) childFragmentManager.popBackStackImmediate()
        else dismissNow()
    }
    override fun onDestroyView() {
        modalBack?.remove()
        modalBack = null
        super.onDestroyView()
    }
    override fun onDestroy() {
        // onDismiss 可能发生在 FragmentManager 真正执行 remove 之前；到 onDestroy 才确认离栈。
        if (isRemoving && !parentFragmentManager.isStateSaved) {
            val source = sourcePageId?.let { urnCoordinator.page(it)?.fragment }
                ?: sourceTag?.let { parentFragmentManager.findFragmentByTag(it) }
            if (source?.isAdded == true && source.isHidden) parentFragmentManager.beginTransaction().show(source).commit()
        }
        super.onDestroy()
    }
    companion object {
        /** 由 Activity 的 DefaultHardwareBackBtnHandler 调用，不再次进入 RN。 */
        fun dispatchDefaultBack(manager: FragmentManager): Boolean {
            val modal = manager.fragments.asReversed().filterIsInstance<URNModalFragment>()
                .firstOrNull { it.isAdded && it.dialog?.isShowing == true } ?: return false
            modal.invokeDefaultBackPressed()
            return true
        }
        internal fun create(pageId: String, sourceTag: String?, sourcePageId: String?) = URNModalFragment().apply {
            arguments = Bundle().apply {
                putString("urn.modal.pageId", pageId)
                putString("urn.modal.sourceTag", sourceTag)
                putString("urn.modal.sourcePageId", sourcePageId)
            }
        }
    }
}
