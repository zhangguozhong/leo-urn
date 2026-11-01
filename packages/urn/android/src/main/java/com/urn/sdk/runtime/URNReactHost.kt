package com.urn.sdk.runtime

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.content.Intent
import android.content.Context
import com.facebook.react.ReactHost
import com.facebook.react.bridge.JSBundleLoader
import com.facebook.react.common.annotations.FrameworkAPI
import com.facebook.react.common.annotations.UnstableReactNativeAPI
import com.facebook.react.defaults.DefaultComponentsRegistry
import com.facebook.react.defaults.DefaultReactHostDelegate
import com.facebook.react.defaults.DefaultTurboModuleManagerDelegate
import com.facebook.react.fabric.ComponentFactory
import com.facebook.react.interfaces.fabric.ReactSurface
import com.facebook.react.modules.core.DefaultHardwareBackBtnHandler
import com.facebook.react.runtime.ReactHostImpl
import com.urn.sdk.URNConfiguration
import com.urn.sdk.URNPackage
import com.urn.sdk.lifecycle.URNHostLifetime

/** 自有 Host 避开默认工厂的静态缓存；Surface 和 Runtime 分开管理。 */
@OptIn(UnstableReactNativeAPI::class, FrameworkAPI::class)
internal class URNReactHost(application: Application, configuration: URNConfiguration, val state: URNRuntimeState) {
    private val lifetime = URNHostLifetime()
    val isRetired get() = lifetime.retired
    fun invalidate() = lifetime.retire { host.invalidate() }
    val host: ReactHost
    init {
        val packages = configuration.reactPackages.filterNot { it is URNPackage } + URNPackage(state)
        val delegate = DefaultReactHostDelegate(
            jsMainModulePath = configuration.jsMainModulePath,
            jsBundleLoader = JSBundleLoader.createAssetLoader(application, "assets://${configuration.bundleAssetPath}", true),
            reactPackages = packages,
            bindingsInstaller = URNBindingsInstaller.create(state),
            exceptionHandler = { error -> state.withOwner { it.runtimeFailed(state, error) } },
            turboModuleManagerDelegateBuilder = DefaultTurboModuleManagerDelegate.Builder(),
        )
        val componentFactory = ComponentFactory()
        DefaultComponentsRegistry.register(componentFactory)
        host = ReactHostImpl(application, delegate, componentFactory,
            allowPackagerServerAccess = configuration.developerSupport, useDevSupport = configuration.developerSupport)
        host.addBeforeDestroyListener { state.withOwner { it.runtimeModulesLost(state) } }
    }
    fun activityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) =
        lifetime.whileActive { host.onActivityResult(activity, requestCode, resultCode, data) }
    fun newIntent(intent: Intent) = lifetime.whileActive { host.onNewIntent(intent) }
    fun windowFocusChanged(hasFocus: Boolean) = lifetime.whileActive { host.onWindowFocusChange(hasFocus) }
    fun configurationChanged(context: Context) = lifetime.whileActive { host.onConfigurationChanged(context) }
    fun userLeaveHint(activity: Activity) = lifetime.whileActive { host.onHostLeaveHint(activity) }
    fun backPressed(): Boolean {
        var handled = false
        lifetime.whileActive { handled = host.onBackPressed() }
        return handled
    }
    fun surface(activity: Activity, props: Bundle): ReactSurface {
        check(!isRetired) { "RN Host 已永久退役" }
        return host.createSurface(activity, "URNRoot", props)
    }
    fun resume(activity: Activity, backHandler: DefaultHardwareBackBtnHandler?) = lifetime.whileActive { host.onHostResume(activity, backHandler) }
    fun pause(activity: Activity) = lifetime.whileActive { host.onHostPause(activity) }
    fun activityDestroyed(activity: Activity) = lifetime.whileActive { host.onHostDestroy(activity) }
}
