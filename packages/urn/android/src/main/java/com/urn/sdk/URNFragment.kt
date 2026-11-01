package com.urn.sdk

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import androidx.fragment.app.Fragment
import java.util.UUID

/** 宿主导航拥有 Fragment；URN 只拥有其中的 Surface 和通信生命周期。 */
class URNFragment : Fragment() {
    private var token: String? = null
    private var owner: URNCoordinator? = null
    internal val pageId get() = arguments?.getString("urn.pageId")

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        val frame = FrameLayout(requireContext())
        val coordinator = (parentFragment as? URNCoordinatorOwner)?.urnCoordinator
            ?: (activity as? URNCoordinatorOwner)?.urnCoordinator
            ?: (activity?.application as? URNCoordinatorOwner)?.urnCoordinator
        owner = coordinator
        val id = pageId
        if (coordinator == null || id == null || !coordinator.containsPage(id)) {
            frame.addView(TextView(requireContext()).apply { text = "URN 页面已失效，请由宿主重新打开" })
            return frame
        }
        owner = coordinator
        val viewToken = UUID.randomUUID().toString()
        token = viewToken
        coordinator.attach(id, this, frame, viewToken)
        return frame
    }

    override fun onResume() { super.onResume(); pageId?.let { owner?.visibility(it, !isHidden) } }
    override fun onPause() { pageId?.let { owner?.visibility(it, false) }; super.onPause() }
    override fun onHiddenChanged(hidden: Boolean) { super.onHiddenChanged(hidden); pageId?.let { owner?.visibility(it, !hidden && isResumed) } }
    override fun onDestroyView() {
        val id = pageId
        val viewToken = token
        token = null
        val removing = generateSequence(this as Fragment?) { it.parentFragment }.any { it.isRemoving }
        if (id != null && viewToken != null) owner?.detach(id, viewToken, removing || activity?.isFinishing == true)
        super.onDestroyView()
    }

    companion object {
        internal fun create(pageId: String) = URNFragment().apply { arguments = Bundle().apply { putString("urn.pageId", pageId) } }
    }
}
