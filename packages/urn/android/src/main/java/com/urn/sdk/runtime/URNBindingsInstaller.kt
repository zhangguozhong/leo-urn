package com.urn.sdk.runtime

import com.facebook.jni.HybridData
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.runtime.BindingsInstaller
import com.facebook.soloader.SoLoader

/** 使用 RN 的安装钩子，不能在 bundle 加载完成后补写轮次。 */
@DoNotStrip
internal class URNBindingsInstaller private constructor(data: HybridData) : BindingsInstaller(data) {
    companion object {
        init { SoLoader.loadLibrary("urnbindings") }
        @JvmStatic private external fun initHybrid(state: URNRuntimeState): HybridData
        fun create(state: URNRuntimeState) = URNBindingsInstaller(initHybrid(state))
    }
}
