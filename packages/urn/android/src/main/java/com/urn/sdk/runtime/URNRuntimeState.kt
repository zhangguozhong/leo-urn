package com.urn.sdk.runtime

import com.facebook.proguard.annotations.DoNotStrip
import com.google.gson.JsonObject
import com.aeris.sdk.BridgeDispatcher
import com.urn.sdk.URNCoordinator
import com.urn.sdk.modules.URNChannelModule
import com.urn.sdk.modules.URNLifecycleModule
import com.urn.sdk.routing.URNEventSink
import com.urn.sdk.routing.URNChannelBudget
import java.lang.ref.WeakReference
import java.util.UUID

/** 与实际 ReactHost 绑定，不保存进程级“当前页面”或“当前模块”。 */
@DoNotStrip
internal class URNRuntimeState(
    val dispatcher: BridgeDispatcher,
    private val budget: URNChannelBudget,
    coordinator: URNCoordinator,
) {
    private val owner = WeakReference(coordinator)
    @Volatile var generation: String? = null
        private set
    private var channelModule: URNChannelModule? = null
    private var lifecycleModule: URNLifecycleModule? = null
    val sink = object : URNEventSink {
        override fun onMessage(runtimeGeneration: String, channelId: String, deliveryId: String, message: String) {
            channelModule?.message(runtimeGeneration, channelId, deliveryId, message)
        }
        override fun onPageEvent(runtimeGeneration: String, channelId: String, deliveryId: String, message: String) {
            lifecycleModule?.pageEvent(runtimeGeneration, channelId, deliveryId, message)
        }
        override fun onCloseRequested(runtimeGeneration: String, channelId: String, deliveryId: String, reason: String) {
            lifecycleModule?.closeRequested(runtimeGeneration, channelId, deliveryId, reason)
        }
        override fun onDisconnect(runtimeGeneration: String, code: String, message: String) {
            channelModule?.disconnect(runtimeGeneration, code, message)
        }
    }

    @Synchronized @DoNotStrip fun nextBootstrap(): String {
        val value = UUID.randomUUID().toString()
        generation = value
        dispatcher.execute { owner.get()?.runtimeBootstrap(this, value) }
        return JsonObject().apply {
            addProperty("generation", value)
            add("budget", JsonObject().apply { budget.values().forEach { (k, v) -> addProperty(k, v) } })
        }.toString()
    }

    fun bindChannel(module: URNChannelModule) = dispatcher.execute {
        channelModule = module
        owner.get()?.runtimeSinkChanged(this)
    }
    fun bindLifecycle(module: URNLifecycleModule) = dispatcher.execute {
        lifecycleModule = module
        owner.get()?.runtimeSinkChanged(this)
    }
    fun unbindChannel(module: URNChannelModule) = dispatcher.execute {
        if (channelModule === module) {
            channelModule = null
            owner.get()?.runtimeModulesLost(this)
        }
    }
    fun unbindLifecycle(module: URNLifecycleModule) = dispatcher.execute {
        if (lifecycleModule === module) lifecycleModule = null
    }
    fun readySink(): URNEventSink? = if (channelModule != null && lifecycleModule != null) sink else null
    fun withOwner(action: (URNCoordinator) -> Unit) = dispatcher.execute { owner.get()?.let(action) }
}
