package com.urn.sdk.modules

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import com.urn.sdk.codegen.NativeURNChannelSpec
import com.urn.sdk.routing.URNAddress
import com.urn.sdk.runtime.URNRuntimeState

@ReactModule(name = URNChannelModule.NAME)
internal class URNChannelModule(context: ReactApplicationContext, private val state: URNRuntimeState) : NativeURNChannelSpec(context) {
    companion object { const val NAME = "URNChannel" }
    init { state.bindChannel(this) }
    override fun send(runtimeGeneration: String, channelId: String, message: String) {
        state.withOwner { it.receive(state, URNAddress(runtimeGeneration, channelId), message) }
    }
    override fun acknowledge(generation: String, channel: String, deliveryId: String) {
        state.withOwner { it.acknowledge(state, URNAddress(generation, channel), deliveryId) }
    }
    fun message(generation: String, channel: String, delivery: String, text: String) {
        emitOnMessage(Arguments.createMap().apply {
            putString("runtimeGeneration", generation); putString("channelId", channel)
            putString("deliveryId", delivery); putString("message", text)
        })
    }
    fun disconnect(generation: String, code: String, reason: String) {
        emitOnDisconnect(Arguments.createMap().apply {
            putString("runtimeGeneration", generation); putString("code", code); putString("message", reason)
        })
    }
    override fun invalidate() { state.unbindChannel(this); super.invalidate() }
}
