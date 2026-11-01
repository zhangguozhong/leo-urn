package com.urn.sdk.modules

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import com.urn.sdk.codegen.NativeURNLifecycleSpec
import com.urn.sdk.routing.URNAddress
import com.urn.sdk.runtime.URNRuntimeState

@ReactModule(name = URNLifecycleModule.NAME)
internal class URNLifecycleModule(context: ReactApplicationContext, private val state: URNRuntimeState) : NativeURNLifecycleSpec(context) {
    companion object { const val NAME = "URNLifecycle" }
    init { state.bindLifecycle(this) }
    override fun boot(generation: String) = state.withOwner { it.boot(state, generation) }
    override fun mounted(generation: String, channel: String) = state.withOwner { it.mounted(state, URNAddress(generation, channel)) }
    override fun bridgeReady(generation: String, channel: String) = state.withOwner { it.bridgeReady(state, URNAddress(generation, channel)) }
    override fun ready(generation: String, channel: String) = state.withOwner { it.ready(state, URNAddress(generation, channel)) }
    override fun disposed(generation: String, channel: String) = state.withOwner { it.disposed(state, URNAddress(generation, channel)) }
    override fun startupFailed(generation: String, channel: String, code: String, message: String) =
        state.withOwner { it.startupFailed(state, URNAddress(generation, channel), code, message) }
    override fun command(generation: String, channel: String, command: String, id: String, payload: String) =
        state.withOwner { it.command(state, URNAddress(generation, channel), command, id, payload) }
    fun pageEvent(generation: String, channel: String, delivery: String, message: String) {
        emitOnPageEvent(Arguments.createMap().apply {
            putString("runtimeGeneration", generation); putString("channelId", channel)
            putString("deliveryId", delivery); putString("message", message)
        })
    }
    fun closeRequested(generation: String, channel: String, delivery: String, reason: String) {
        emitOnCloseRequested(Arguments.createMap().apply {
            putString("runtimeGeneration", generation); putString("channelId", channel)
            putString("deliveryId", delivery); putString("reason", reason)
        })
    }
    override fun invalidate() { state.unbindLifecycle(this); super.invalidate() }
}
