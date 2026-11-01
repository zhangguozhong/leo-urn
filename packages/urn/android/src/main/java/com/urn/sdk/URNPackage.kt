package com.urn.sdk

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.urn.sdk.modules.URNChannelModule
import com.urn.sdk.modules.URNLifecycleModule
import com.urn.sdk.runtime.URNRuntimeState

/** 无参构造供自动链接识别，URNReactHost 会替换成当前 Host 独占的配置实例。 */
class URNPackage public constructor() : BaseReactPackage() {
    private var state: URNRuntimeState? = null
    internal constructor(state: URNRuntimeState) : this() { this.state = state }

    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
        if (name !in setOf(URNChannelModule.NAME, URNLifecycleModule.NAME)) return null
        val runtime = checkNotNull(state) { "请通过 URNCoordinator 创建 RN Host，不能启动另一份默认 Host" }
        return when (name) {
            URNChannelModule.NAME -> URNChannelModule(reactContext, runtime)
            else -> URNLifecycleModule(reactContext, runtime)
        }
    }
    override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
        mapOf(
            URNChannelModule.NAME to ReactModuleInfo(URNChannelModule.NAME, URNChannelModule::class.java.name, false, false, false, true),
            URNLifecycleModule.NAME to ReactModuleInfo(URNLifecycleModule.NAME, URNLifecycleModule::class.java.name, false, false, false, true),
        )
    }
}
