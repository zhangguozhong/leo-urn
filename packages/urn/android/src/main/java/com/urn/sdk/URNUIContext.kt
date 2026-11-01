package com.urn.sdk

import android.app.Activity
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import com.aeris.sdk.ManagedBridgeUIContext
import com.aeris.sdk.AndroidContainerBridgeUIContext
import java.lang.ref.WeakReference

/** 固定属于本次 View 挂载；原有 Session 不会转而获取重建后的 Activity 或容器。 */
class URNUIContext internal constructor(fragment: Fragment, container: ViewGroup) :
    ManagedBridgeUIContext(), AndroidContainerBridgeUIContext {
    private val activity = WeakReference(fragment.activity)
    private val owner = WeakReference(fragment)
    private val root = WeakReference(container)
    override val isValid get() = super.isValid && root.get() != null &&
        activity.get()?.let { !it.isFinishing && !it.isDestroyed } == true
    override val containerView: ViewGroup? get() = root.get()?.takeIf { isValid }
    fun activity(): Activity? = activity.get()?.takeIf { isValid }
    fun fragment(): Fragment? = owner.get()?.takeIf { isValid }
    override fun invalidate() { super.invalidate(); root.clear() }
}
