package com.urn.sdk

import android.app.Activity
import android.app.Application
import android.content.Intent
import android.content.res.Configuration
import android.view.View
import android.view.ViewGroup
import com.facebook.react.modules.core.PermissionListener
import androidx.core.app.ActivityCompat
import com.google.gson.JsonParser
import com.urn.sdk.lifecycle.URNNavigationTransition
import com.urn.sdk.lifecycle.URNNavigationState
import com.urn.sdk.lifecycle.URNPermissionRequests
import android.widget.FrameLayout
import androidx.fragment.app.Fragment
import com.facebook.react.bridge.Arguments
import com.facebook.react.interfaces.fabric.ReactSurface
import com.facebook.react.modules.core.DefaultHardwareBackBtnHandler
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.reflect.TypeToken
import com.aeris.sdk.BridgeCancellation
import com.urn.sdk.lifecycle.URNRuntimeLifecycle
import com.urn.sdk.lifecycle.URNCloseBarrier
import com.urn.sdk.routing.URNAddress
import com.urn.sdk.routing.URNChannelRouter
import com.urn.sdk.runtime.URNReactHost
import com.urn.sdk.runtime.URNRuntimeState
import com.urn.sdk.runtime.URNTaskObserver
import java.lang.ref.WeakReference
import java.util.UUID

/** App 拥有一个 Coordinator；所有页面共享 Host，各自拥有地址、Session 与 UIContext。 */
class URNCoordinator(private val application: Application, private val configuration: URNConfiguration) {
    enum class State { IDLE, STARTING, RUNNING, RELOADING, STOPPING, FAILED }
    private val lifecycle = URNRuntimeLifecycle()
    val state: State get() = State.valueOf(lifecycle.state.name)
    val generation: String? get() = router?.generation
    val pageCount get(): Int { dispatcher.checkThread(); return records.size }
    val pages get(): List<URNPageHandle> { dispatcher.checkThread(); return records.values.map { it.handle } }
    private val dispatcher get() = configuration.engine.dispatcher
    private val records = linkedMapOf<String, Record>()
    private var runtime: URNReactHost? = null
    private var router: URNChannelRouter? = null
    private var foreground = false
    private var resumedActivity: WeakReference<Activity>? = null
    private var resumedBackHandler: WeakReference<DefaultHardwareBackBtnHandler>? = null
    private var destroyingHost = false
    private var runtimeStopFailure: Throwable? = null
    private var reloadRequested = false
    private val permissionRequests = URNPermissionRequests<Activity, PermissionListener>()
    private val reloadCallbacks = mutableListOf<(Result<Unit>) -> Unit>()
    private val shutdownCallbacks = mutableListOf<(Result<Unit>) -> Unit>()

    private data class Mount(val fragment: WeakReference<Fragment>, val frame: FrameLayout, val token: String)
    private class Record(
        val handle: URNPageHandle, val params: JsonObject, val policy: URNPagePolicy,
        var readyCallback: ((Result<URNPageHandle>) -> Unit)?, val onResult: (URNPageResult) -> Unit,
    ) {
        var mount: Mount? = null
        var fragment: WeakReference<Fragment>? = null
        var pending: Mount? = null
        var surface: ReactSurface? = null
        var address: URNAddress? = null
        var route: URNChannelRouter? = null
        var context: URNUIContext? = null
        var jsDisposed = false
        var mounted = false
        var bridgeReady = false
        var businessReady = false
        var visible = false
        var lifecycleSequence = 0L
        var startup: BridgeCancellation? = null
        var barrier: URNCloseBarrier? = null
        var closeAttempt: String? = null
        var cleanupAttempt: String? = null
        var finalClose = false
        var closeResult: Result<Unit>? = null
        val closeCallbacks = mutableListOf<(Result<Unit>) -> Unit>()
        var result = URNPageResult.cancelled()
        var overlay: View? = null
        var failure: Throwable? = null
        val navigation = URNNavigationState()
        var navigationClose: URNNavigationTransition? = null
        var navigationOpen: URNNavigationTransition? = null
        var openRejected = false
        var origin: URNAddress? = null
        var originRequest: String? = null
        val createdAtNanos = System.nanoTime()
        val children = linkedMapOf<String, URNPageHandle>()
        val retryCallbacks = mutableListOf<(Result<Unit>) -> Unit>()
    }

    fun open(
        featureId: String, params: JsonObject = JsonObject(), policy: URNPagePolicy = URNPagePolicy(),
        onReady: (Result<URNPageHandle>) -> Unit = {}, onResult: (URNPageResult) -> Unit = {},
    ): URNPageHandle {
        dispatcher.checkThread()
        check(state !in setOf(State.STOPPING, State.RELOADING, State.FAILED)) { "运行时当前不能打开新页面" }
        require(featureId.length in 1..80 && Regex("^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$").matches(featureId))
        check(records.size < configuration.maxPages) { "页面达到预算，清理中的页面仍占用名额" }
        require(params.toString().toByteArray(Charsets.UTF_8).size <= 16384) { "页面参数超过 16 KiB" }
        val handle = URNPageHandle(UUID.randomUUID().toString(), featureId, this)
        records[handle.id] = Record(handle, params.deepCopy(), policy.copy(permissions = policy.permissions.toSet(), eventTopics = policy.eventTopics?.toSet()), onReady, onResult)
        try { ensureRuntime() } catch (error: Exception) { records.remove(handle.id); throw error }
        val record = checkNotNull(records[handle.id])
        record.startup = dispatcher.schedule(configuration.startupTimeoutMs) {
            if (records[handle.id] === record && !record.businessReady && record.failure == null && !record.finalClose) {
                failPage(record, URNContainerException("STARTUP_TIMEOUT", "等待运行时或首屏就绪超时"), "STARTUP_TIMEOUT", jsGone = record.address == null)
            }
        }
        return handle
    }

    fun containsPage(id: String): Boolean { dispatcher.checkThread(); return id in records }
    internal fun page(id: String): URNPageHandle? { dispatcher.checkThread(); return records[id]?.handle }
    internal fun fragment(page: URNPageHandle, fallback: Fragment? = null): Fragment {
        dispatcher.checkThread()
        val record = records[page.id] ?: return checkNotNull(fallback) { "页面已经关闭" }
        return record.fragment?.get() ?: URNFragment.create(page.id).also { record.fragment = WeakReference(it) }
    }
    internal fun address(page: URNPageHandle): URNAddress? { dispatcher.checkThread(); return records[page.id]?.address }
    internal fun isReady(page: URNPageHandle): Boolean { dispatcher.checkThread(); return records[page.id]?.let { it.mounted && it.bridgeReady && it.businessReady && it.barrier == null } == true }

    private fun ensureRuntime() {
        if (runtime != null) return
        lifecycle.starting(reloadRequested)
        val bindings = URNRuntimeState(dispatcher, configuration.channelBudget, this)
        val host = URNReactHost(application, configuration, bindings)
        runtime = host
        resumedActivity?.get()?.takeIf { foreground && !it.isFinishing && !it.isDestroyed }?.let {
            host.resume(it, resumedBackHandler?.get())
        }
        URNTaskObserver.observe(host.host.start(), dispatcher) { result ->
            result.exceptionOrNull()?.let { if (runtime === host && !destroyingHost) runtimeFailed(bindings, it) }
        }
    }

    internal fun attach(id: String, fragment: Fragment, frame: FrameLayout, token: String) {
        dispatcher.checkThread()
        val record = records[id] ?: return
        if (record.finalClose) return
        record.fragment = WeakReference(fragment)
        record.pending = Mount(WeakReference(fragment), frame, token)
        if (record.failure != null) showFailure(record)
        else runCatching { showOverlay(record, configuration.pageUI.loading(record.handle)) }
            .onFailure { diagnostic("page.uiFailed", record, "UI_FACTORY_FAILED") }
        mount(record)
    }

    private fun mount(record: Record) {
        val route = router ?: return
        val host = runtime ?: return
        val pending = record.pending ?: return
        val fragment = pending.fragment.get() ?: return
        val activity = fragment.activity ?: return
        if (state == State.STOPPING || state == State.FAILED || record.surface != null || record.barrier != null || record.finalClose || destroyingHost) return
        if (record.failure != null) {
            showFailure(record)
            return
        }
        record.pending = null
        val context = URNUIContext(fragment, pending.frame)
        val address = URNAddress(route.generation, UUID.randomUUID().toString())
        record.address = address; record.route = route; record.context = context; record.mount = pending
        record.jsDisposed = false
        record.mounted = false; record.bridgeReady = false; record.businessReady = false
        try {
            route.open(address, context, record.policy.permissions, record.policy.eventTopics)
            val contextMap = mapOf("pageId" to record.handle.id, "channelId" to address.channel,
                "runtimeGeneration" to address.generation, "baselineId" to configuration.baselineId)
            val params: Map<String, Any?> = Gson().fromJson(record.params, object : TypeToken<Map<String, Any?>>() {}.type)
            val props = Arguments.toBundle(Arguments.makeNativeMap(mapOf("featureId" to record.handle.featureId,
                "params" to params, "containerContext" to contextMap)))
            val surface = host.surface(activity, props ?: android.os.Bundle())
            record.surface = surface
            val view = checkNotNull(surface.view) { "RN 没有创建 Surface View" }
            pending.frame.removeAllViews()
            pending.frame.addView(view, FrameLayout.LayoutParams(-1, -1))
            showOverlay(record, configuration.pageUI.loading(record.handle))
            record.handle.state = URNPageHandle.State.STARTING
            diagnostic("page.mounting", record, null)
            record.startup?.cancel()
            record.startup = dispatcher.schedule(configuration.startupTimeoutMs) {
                if (record.address == address && !record.businessReady) startupFailed(host.state, address, "STARTUP_TIMEOUT", "RN 页面启动等待超时")
            }
            URNTaskObserver.observe(surface.start(), dispatcher) { result ->
                result.exceptionOrNull()?.let { if (record.address == address) startupFailed(host.state, address, "SURFACE_FAILED", "RN Surface 启动失败") }
            }
        } catch (error: Exception) {
            failPage(record, error, "SURFACE_FAILED", jsGone = true)
        }
    }

    internal fun detach(id: String, token: String, final: Boolean) {
        dispatcher.checkThread()
        val record = records[id] ?: return
        val pendingMatches = record.pending?.token == token
        val mountedMatches = record.mount?.token == token
        if (!pendingMatches && !mountedMatches) return
        if (pendingMatches) record.pending = null
        record.context?.invalidate()
        record.overlay = null
        if (final) {
            record.finalClose = true
            record.pending = null
        }
        beginClose(record, "VIEW_DESTROYED")
    }

    internal fun visibility(id: String, visible: Boolean) {
        val record = records[id] ?: return
        record.visible = visible
        record.handle.lifecycle = URNPageLifecycle(visible, foreground, record.finalClose)
        publishLifecycle(record)
    }

    private fun publishLifecycle(record: Record) {
        record.handle.lifecycle = URNPageLifecycle(record.visible, foreground, record.finalClose)
        val address = record.address ?: return
        if (!record.mounted || record.barrier != null) return
        val message = JsonObject().apply {
            addProperty("type", "lifecycle"); addProperty("seq", ++record.lifecycleSequence)
            addProperty("visible", record.visible); addProperty("foreground", foreground)
        }
        record.route?.enqueuePageEvent(address, message.toString())
    }

    fun close(page: URNPageHandle, result: URNPageResult = URNPageResult.cancelled(), completion: (Result<Unit>) -> Unit = {}) {
        dispatcher.checkThread()
        val record = records[page.id]
        if (record == null) { completion(Result.success(Unit)); return }
        require(result.data == null || result.data.toString().toByteArray(Charsets.UTF_8).size <= 16384) { "返回值超过预算" }
        if (!record.finalClose) record.result = result.copy(data = result.data?.deepCopy())
        record.finalClose = true; record.pending = null
        record.handle.state = URNPageHandle.State.CLOSING
        val completed = record.closeResult
        if (completed != null) completion(completed) else record.closeCallbacks.add(completion)
        beginClose(record, "PAGE_CLOSED")
    }

    private fun beginClose(record: Record, reason: String, jsGone: Boolean = false) {
        if (record.barrier != null) { if (jsGone) record.barrier?.disposed(); return }
        val address = record.address
        val surface = record.surface
        val attempt = UUID.randomUUID().toString()
        record.closeAttempt = attempt
        record.startup?.cancel(); record.startup = null
        record.route?.let { route -> if (address != null) route.beginClosing(address) }
        record.context?.invalidate()
        record.barrier = URNCloseBarrier(dispatcher, configuration.closeTimeoutMs, { completion ->
            if (surface == null) completion(Result.success(Unit))
            else URNTaskObserver.observe(surface.stop(), dispatcher) { stopped ->
                val released = stopped.mapCatching {
                    surface.view?.let { (it.parent as? ViewGroup)?.removeView(it) }
                    surface.clear()
                    surface.detach()
                }
                completion(released)
            }
        }, { outcome ->
            if (record.closeAttempt == attempt) {
                record.closeResult = outcome
                if (outcome.isFailure) {
                    val callbacks = record.closeCallbacks.toList(); record.closeCallbacks.clear()
                    callbacks.forEach { runCatching { it(outcome) } }
                    record.handle.error = outcome.exceptionOrNull()
                    record.handle.state = URNPageHandle.State.FAILED
                    diagnostic("close.failed", record, "CLEANUP_INCOMPLETE")
                    outcome.exceptionOrNull()?.let(::failReload)
                }
            }
        }, {
            if (record.closeAttempt == attempt) release(record, address)
        }, onTimeout = {
            if (record.closeAttempt == attempt) {
                if (address != null) record.route?.close(address)
                // 原生通道已封闭后不再依赖失联 JS 确认；仍等待业务清理和实际 Surface.stop。
                record.jsDisposed = true
                record.barrier?.disposed()
            }
        })
        if (jsGone || record.jsDisposed || address == null || surface == null) record.barrier?.disposed()
        else record.route?.enqueueCloseRequested(address, reason)
        val cleanupAttempt = UUID.randomUUID().toString()
        record.cleanupAttempt = cleanupAttempt
        try { configuration.cleanup(record.handle) { outcome -> dispatcher.execute {
            if (record.closeAttempt == attempt && record.cleanupAttempt == cleanupAttempt) record.barrier?.cleanupCompleted(outcome)
        } } }
        catch (error: Exception) { record.barrier?.cleanupCompleted(Result.failure(error)) }
    }

    private fun release(record: Record, address: URNAddress?) {
        val completed = record.closeCallbacks.toList(); record.closeCallbacks.clear()
        if (address != null) record.route?.close(address)
        record.overlay?.let { (it.parent as? ViewGroup)?.removeView(it) }
        record.overlay = null
        record.surface = null; record.address = null; record.route = null; record.context = null; record.mount = null
        record.barrier = null; record.closeAttempt = null; record.closeResult = null
        record.mounted = false; record.bridgeReady = false; record.businessReady = false
        if (record.finalClose) {
            records.remove(record.handle.id)
            // 最后一页释放后立即封住重入打开；只有实际 Host 销毁成功才重新进入 IDLE。
            if (records.isEmpty() && !reloadRequested) lifecycle.stopping()
            record.handle.state = URNPageHandle.State.CLOSED
            record.handle.lifecycle = URNPageLifecycle(closed = true)
            record.handle.canRetry = false
            record.children.keys.toList().forEach { cancelLaunch(record, it) }
            completeReady(record, Result.failure(IllegalStateException("页面在就绪前关闭")))
            runCatching { record.onResult(record.result) }
        } else if (record.failure != null) {
            record.handle.canRetry = runtime?.isRetired == false && state == State.RUNNING
            showFailure(record)
        } else if (!reloadRequested) mount(record)
        maybeReloadReady()
        // 成功回调发生在记录摘除/退役之后，重入打开页面不会误占旧页面配额。
        completed.forEach { runCatching { it(Result.success(Unit)) } }
        advanceStop()
    }

    fun closeAll(completion: (Result<Unit>) -> Unit = {}) {
        dispatcher.checkThread()
        // 旧 Host 仍未实际释放时，重复关闭必须返回已知故障，不能再次调用已退役 Host。
        val previousFailure = runtimeStopFailure
        if (records.isEmpty() && runtime != null && previousFailure != null) {
            completion(Result.failure(previousFailure))
            return
        }
        lifecycle.stopping()
        shutdownCallbacks.add(completion)
        failReload(URNContainerException("CANCELLED", "完整关闭取消了 Reload"))
        lifecycle.stopping()
        closePages { outcome ->
            val stopFailure = runtimeStopFailure?.takeIf { runtime != null }
            when {
                outcome.isFailure -> finishShutdown(outcome)
                stopFailure != null -> { lifecycle.failed(); finishShutdown(Result.failure(stopFailure)) }
                else -> advanceStop()
            }
        }
    }

    private fun closePages(completion: (Result<Unit>) -> Unit) {
        val current = records.values.map { it.handle }
        if (current.isEmpty()) { completion(Result.success(Unit)); return }
        var left = current.size
        var error: Throwable? = null
        current.forEach { page -> close(page) { outcome ->
            if (outcome.isFailure && error == null) error = outcome.exceptionOrNull()
            if (--left == 0) completion(error?.let { Result.failure(it) } ?: Result.success(Unit))
        } }
    }

    fun shutdown(completion: (Result<Unit>) -> Unit = {}) {
        closeAll(completion)
    }

    fun reload(completion: (Result<Unit>) -> Unit = {}) {
        dispatcher.checkThread()
        if (records.values.any { it.navigation.busy }) {
            completion(Result.failure(URNContainerException("NAVIGATION_BUSY", "请先完成或恢复导航，再执行 Reload")))
            return
        }
        if (reloadRequested || !lifecycle.beginReload()) { completion(Result.failure(IllegalStateException("运行时当前不能 Reload"))); return }
        reloadRequested = true; reloadCallbacks.add(completion)
        records.values.toList().forEach { record ->
            record.navigation.rotate()
            record.navigationOpen = null
            record.navigationClose = null
            if (record.pending == null) record.pending = record.mount
            record.failure = null
            record.handle.error = null
            record.handle.canRetry = false
            beginClose(record, "RELOAD")
        }
        advanceStop()
    }

    private fun advanceStop() {
        if (destroyingHost) return
        val shouldStop = state == State.STOPPING && records.isEmpty() || reloadRequested && records.values.all { it.surface == null && it.barrier == null }
        if (!shouldStop) return
        val host = runtime
        if (host == null) {
            if (reloadRequested && records.isNotEmpty()) ensureRuntime() else finishRuntimeStop()
            return
        }
        if (host.isRetired) {
            val error = runtimeStopFailure ?: IllegalStateException("RN Host 已永久退役，先前销毁未成功，不能再次调用旧 Host")
            runtimeStopFailure = error
            lifecycle.failed()
            failReload(error)
            finishShutdown(Result.failure(error))
            return
        }
        destroyingHost = true
        permissionRequests.clear()
        router?.closeAll(); router = null
        var settled = false
        var expired = false
        fun fail(error: Throwable) {
            runtimeStopFailure = error
            lifecycle.failed()
            failReload(error)
            finishShutdown(Result.failure(error))
        }
        val deadline = dispatcher.schedule(configuration.closeTimeoutMs) {
            if (runtime === host && !settled) {
                expired = true
                fail(java.util.concurrent.TimeoutException("RN Runtime 销毁超时，实际资源仍未释放"))
            }
        }
        try {
            host.host.destroy("URN host cleanup", null) { success -> dispatcher.execute {
                if (runtime !== host || settled) return@execute
                settled = true
                deadline.cancel()
                destroyingHost = false
                if (!success) {
                    fail(IllegalStateException("RN Runtime 未完成销毁"))
                    return@execute
                }
                runtime = null
                // 超时后迟到的释放仅回收旧 Host，不复活失败的 Reload。
                if (expired) return@execute
                if (reloadRequested && records.isNotEmpty()) {
                    try { ensureRuntime() } catch (error: Exception) { fail(error) }
                } else {
                    finishRuntimeStop()
                }
            } }
            // invalidate 内部也会 destroy。必须在同一主线程栈内标记永久退役，
            // 与尚未完成的 destroy 合并；完成后再调会启动第二次空销毁并遗漏该阶段等待。
            // 此后不再调用旧 Host 的任何方法，完成点仍由上面的真实 destroy callback 决定。
            host.invalidate()
        } catch (error: Exception) {
            settled = true
            deadline.cancel()
            destroyingHost = false
            fail(error)
        }
    }

    private fun failReload(error: Throwable) {
        if (!reloadRequested && reloadCallbacks.isEmpty()) return
        reloadRequested = false
        lifecycle.failed()
        val callbacks = reloadCallbacks.toList(); reloadCallbacks.clear()
        callbacks.forEach { runCatching { it(Result.failure(error)) } }
    }

    private fun finishShutdown(result: Result<Unit>) {
        val callbacks = shutdownCallbacks.toList(); shutdownCallbacks.clear()
        callbacks.forEach { runCatching { it(result) } }
    }

    private fun finishRuntimeStop() {
        // Reload 的销毁确认可能晚于 closeAll 新建的页面清理；两个阶段均完成后才能进入 IDLE。
        if (runtime != null || destroyingHost || records.isNotEmpty()) return
        runtimeStopFailure = null
        reloadRequested = false
        lifecycle.destroyed()
        val reload = reloadCallbacks.toList(); reloadCallbacks.clear()
        // Reload 期间最后一页也已关闭时，不再创建一个没有页面的新 Host。
        reload.forEach { runCatching { it(Result.success(Unit)) } }
        finishShutdown(Result.success(Unit))
    }

    internal fun runtimeBootstrap(bindings: URNRuntimeState, generation: String) {
        if (runtime?.state !== bindings || destroyingHost || !lifecycle.bootstrap(generation)) return
        val previous = router
        if (previous != null) {
            previous.closeAll()
            records.values.toList().forEach { record ->
                if (record.pending == null) record.pending = record.mount
                beginClose(record, "RUNTIME_REPLACED", jsGone = true)
            }
        }
        router = URNChannelRouter(configuration.engine, generation, configuration.channelBudget, bindings.readySink()) { address, code, _ ->
            records.values.firstOrNull { it.address == address }?.let { record ->
                diagnostic("channel.failed", record, code)
                failPage(record, URNContainerException(code, "页面通信失败"), code)
            }
        }
        records.values.toList().forEach(::mount)
    }
    internal fun runtimeSinkChanged(bindings: URNRuntimeState) {
        if (runtime?.state === bindings) router?.setEventSink(bindings.readySink())
    }
    internal fun runtimeModulesLost(bindings: URNRuntimeState) {
        if (runtime?.state !== bindings || destroyingHost) return
        // Dev Menu reload 会先使旧模块失效。退役原生连接，等待下一次 JNI bootstrap
        // 确认新 VM 后重绑逻辑页面，不能把旧轮次的错误误当新页面启动失败。
        lifecycle.modulesLost()
        router?.closeAll()
    }
    internal fun runtimeFailed(bindings: URNRuntimeState, error: Throwable) {
        if (runtime?.state !== bindings || destroyingHost) return
        lifecycle.failed()
        failReload(error)
        router?.disconnect("RUNTIME_FAILED", "RN 运行时发生故障")
        records.values.toList().forEach { record ->
            failPage(record, error, "RUNTIME_FAILED", jsGone = true)
        }
    }

    internal fun receive(bindings: URNRuntimeState, address: URNAddress, message: String) {
        if (runtime?.state === bindings && address.generation == bindings.generation) router?.receive(address, message)
    }
    internal fun acknowledge(bindings: URNRuntimeState, address: URNAddress, delivery: String) {
        if (runtime?.state === bindings && address.generation == bindings.generation) router?.acknowledge(address, delivery)
    }
    internal fun boot(bindings: URNRuntimeState, generation: String) {
        if (runtime?.state !== bindings || bindings.generation != generation || !lifecycle.boot(generation)) return
        router?.boot(generation)
        if (reloadRequested) {
            reloadRequested = false
            records.values.toList().forEach(::mount)
        }
        records.values.filter { it.failure != null && it.barrier == null && !it.finalClose }.forEach {
            it.handle.canRetry = true
            showFailure(it)
        }
        maybeReloadReady()
    }
    private fun find(bindings: URNRuntimeState, address: URNAddress): Record? =
        if (runtime?.state === bindings && bindings.generation == address.generation) records.values.firstOrNull { it.address == address } else null
    internal fun mounted(bindings: URNRuntimeState, address: URNAddress) { find(bindings, address)?.let { it.mounted = true; router?.mounted(address); publishLifecycle(it); notifyReady(it) } }
    internal fun bridgeReady(bindings: URNRuntimeState, address: URNAddress) { find(bindings, address)?.takeIf { it.navigation.acceptsWork }?.let { it.bridgeReady = true; notifyReady(it) } }
    internal fun ready(bindings: URNRuntimeState, address: URNAddress) { find(bindings, address)?.takeIf { it.navigation.acceptsWork }?.let { it.businessReady = true; notifyReady(it) } }
    private fun notifyReady(record: Record) {
        if (!record.navigation.acceptsWork || !isReady(record.handle)) return
        record.startup?.cancel(); record.startup = null
        record.handle.state = URNPageHandle.State.READY
        record.handle.error = null
        record.handle.canRetry = false
        showOverlay(record, null)
        completeReady(record, Result.success(record.handle))
        val retries = record.retryCallbacks.toList()
        record.retryCallbacks.clear()
        retries.forEach { runCatching { it(Result.success(Unit)) } }
        diagnostic("page.ready", record, null)
        maybeReloadReady()
    }
    private fun maybeReloadReady() {
        if (state == State.RUNNING && records.values.all { isReady(it.handle) }) {
            val callbacks = reloadCallbacks.toList(); reloadCallbacks.clear()
            callbacks.forEach { runCatching { it(Result.success(Unit)) } }
        }
    }
    internal fun disposed(bindings: URNRuntimeState, address: URNAddress) {
        find(bindings, address)?.let { record ->
            record.jsDisposed = true
            record.route?.close(address)
            if (record.barrier == null) {
                failPage(record, URNContainerException("JS_DISPOSED", "业务连接已经退出"), "JS_DISPOSED", jsGone = true)
            } else record.barrier?.disposed()
        }
    }
    internal fun startupFailed(bindings: URNRuntimeState, address: URNAddress, code: String, message: String) {
        find(bindings, address)?.takeIf { it.navigation.acceptsWork }?.let { record ->
            val error = IllegalStateException("$code: $message")
            completeReady(record, Result.failure(error))
            if (reloadCallbacks.isNotEmpty()) {
                val callbacks = reloadCallbacks.toList()
                reloadCallbacks.clear()
                callbacks.forEach { runCatching { it(Result.failure(error)) } }
            }
            failPage(record, error, code)
        }
    }
    internal fun command(bindings: URNRuntimeState, address: URNAddress, command: String, id: String, payload: String) {
        val source = find(bindings, address) ?: return
        if (source.barrier != null || source.finalClose) return
        try {
            require(payload.toByteArray(Charsets.UTF_8).size <= 16384)
            val value = JsonParser.parseString(payload)
            require(value.isJsonObject)
            val data = value.asJsonObject
            when (command) {
                "open" -> {
                    require(id.isNotEmpty() && id.length <= 80 && id !in source.children)
                    require(source.children.size < 16 && source.visible && foreground)
                    if (source.openRejected || !source.navigation.acceptsWork)
                        throw URNContainerException("NAVIGATION_BUSY", "页面正在关闭或等待恢复")
                    val feature = data.get("featureId")?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString
                        ?: throw URNContainerException("INVALID_NAVIGATION", "缺少业务入口")
                    val params = data.get("params")?.takeIf { it.isJsonObject }?.asJsonObject
                        ?: throw URNContainerException("INVALID_NAVIGATION", "页面参数必须为对象")
                    val presentation = when (data.get("presentation")?.asString) {
                        "push" -> URNPagePresentation.PUSH
                        "present" -> URNPagePresentation.PRESENT
                        else -> throw URNContainerException("INVALID_NAVIGATION", "呈现方式不合法")
                    }
                    val policy = configuration.navigationPagePolicy(source.handle, feature)
                        ?: throw URNContainerException("PERMISSION_DENIED", "宿主拒绝目标页面")
                    var resultOwnerId: String? = null
                    val child = open(feature, params, policy, onResult = { result ->
                        val target = source.children[id]
                        if (target?.id == resultOwnerId && target != null && records[source.handle.id] === source && source.address == address) {
                            source.children.remove(id)
                            val targetRecord = records[target.id]
                            if (targetRecord?.openRejected != true) pageEvent(address, JsonObject().apply {
                                addProperty("type", "result"); addProperty("id", id)
                                add("result", JsonObject().apply {
                                    addProperty("status", result.status)
                                    result.data?.let { add("data", it.deepCopy()) }
                                })
                            })
                        }
                    })
                    resultOwnerId = child.id
                    val target = checkNotNull(records[child.id])
                    target.origin = address
                    target.originRequest = id
                    source.children[id] = child
                    val navigationEpoch = target.navigation.beginOpen()
                    target.navigationOpen = URNNavigationTransition(dispatcher, configuration.navigationTimeoutMs,
                        onSuccess = {
                            if (!target.navigation.matches(navigationEpoch)) return@URNNavigationTransition
                            target.navigation.opened(navigationEpoch)
                            if (!target.finalClose && !target.openRejected) pageEvent(address, JsonObject().apply {
                                addProperty("type", "opened"); addProperty("id", id); addProperty("pageId", child.id)
                            })
                        },
                        onFailure = { code, error ->
                            if (!target.navigation.matches(navigationEpoch)) return@URNNavigationTransition
                            target.navigation.opened(navigationEpoch)
                            target.openRejected = true
                            source.children.remove(id)
                            navigationError(address, id, error ?: URNContainerException(code, "打开页面未完成"))
                            removeNavigation(target)
                        },
                        onLateSuccess = { if (target.navigation.matches(navigationEpoch)) removeNavigation(target) })
                    try {
                        configuration.navigator.open(child, source.handle.fragment, presentation) { result -> target.navigationOpen?.complete(result) }
                    } catch (error: Exception) { target.navigationOpen?.complete(Result.failure(error)) }
                }
                "cancelOpen" -> cancelLaunch(source, id)
                "close" -> {
                    require(id.isEmpty())
                    val result = data.get("data")
                    require(result == null || result.isJsonObject)
                    finish(source.handle, result?.asJsonObject)
                }
                else -> throw URNContainerException("INVALID_NAVIGATION", "未知页面命令")
            }
        } catch (error: Exception) { navigationError(address, id, error) }
    }

    private fun cancelLaunch(source: Record, id: String) {
        val child = source.children[id] ?: return
        val target = records[child.id] ?: return
        val transition = target.navigationOpen
        if (transition?.state == URNNavigationTransition.State.PENDING) transition.cancel()
        else {
            // opened 可能仍在 RN 消费队列内；JS 超时取消优先于未消费的确认。
            source.children.remove(id)
            target.openRejected = true
            removeNavigation(target)
        }
    }

    private fun pageEvent(address: URNAddress, event: JsonObject) {
        val owner = records.values.firstOrNull { it.address == address } ?: return
        if (owner.finalClose || owner.barrier != null) return
        owner.route?.enqueuePageEvent(address, event.toString(), control = event.get("type")?.asString != "opened")
    }

    private fun navigationError(address: URNAddress, id: String, error: Throwable) {
        val code = (error as? URNContainerException)?.code
            ?: if (error is IllegalArgumentException || error is com.google.gson.JsonParseException) "INVALID_NAVIGATION" else "NAVIGATION_FAILED"
        pageEvent(address, JsonObject().apply {
            addProperty("type", "error"); addProperty("id", id); addProperty("code", code)
        })
        diagnostic("navigation.failed", records.values.firstOrNull { it.address == address }, code)
    }

    fun finish(page: URNPageHandle, result: JsonObject? = null) {
        dispatcher.checkThread()
        val record = records[page.id] ?: return
        if (record.finalClose || !record.navigation.acceptsWork || record.navigationClose != null) return
        if (result != null && result.toString().toByteArray(Charsets.UTF_8).size > 16384) {
            record.address?.let { navigationError(it, "", URNContainerException("INVALID_NAVIGATION", "返回值超过预算")) }
            return
        }
        record.result = URNPageResult.completed(result)
        removeNavigation(record)
    }

    fun retryNavigationClose(page: URNPageHandle) {
        dispatcher.checkThread()
        val record = records[page.id] ?: return
        if (page.canRetryNavigationClose) removeNavigation(record)
    }

    private fun removeNavigation(record: Record) {
        if (record.navigationClose != null) return
        // 迟到挂载必须使用同一个 Handle 的 Fragment 撤销，不能重新打开连接。
        if (record.fragment?.get()?.isAdded != true) {
            if (records[record.handle.id] === record) close(record.handle, record.result)
            return
        }
        val navigationEpoch = record.navigation.beginClose()
        record.route?.let { route -> record.address?.let(route::beginClosing) }
        record.startup?.cancel(); record.startup = null
        record.handle.canRetryNavigationClose = false
        record.handle.navigationError = null
        showOverlay(record, null)
        val transition = URNNavigationTransition(dispatcher, configuration.navigationTimeoutMs,
            onSuccess = {
                if (!record.navigation.matches(navigationEpoch)) return@URNNavigationTransition
                record.navigation.closed(navigationEpoch)
                record.navigationClose = null
                if (record.fragment?.get()?.isAdded == true) navigationCloseFailed(record,
                    URNContainerException("NAVIGATION_NOT_REMOVED", "宿主报告成功但页面仍在栈内"))
                else if (records[record.handle.id] === record) close(record.handle, record.result)
            },
            onFailure = { code, error ->
                if (!record.navigation.matches(navigationEpoch)) return@URNNavigationTransition
                record.navigation.closeFailed(navigationEpoch)
                record.navigationClose = null
                if (record.fragment?.get()?.isAdded != true) {
                    if (records[record.handle.id] === record) close(record.handle, record.result)
                } else navigationCloseFailed(record, error ?: URNContainerException(
                    if (code == "NAVIGATION_TIMEOUT") "NAVIGATION_CLOSE_TIMEOUT" else code, "页面仍保留在原生栈内"))
            },
            onLateSuccess = {
                if (record.navigation.matches(navigationEpoch) && records[record.handle.id] === record && record.fragment?.get()?.isAdded != true) close(record.handle, record.result)
            })
        record.navigationClose = transition
        try { configuration.navigator.close(record.handle) { transition.complete(it) } }
        catch (error: Exception) { transition.complete(Result.failure(error)) }
    }

    private fun navigationCloseFailed(record: Record, error: Throwable) {
        record.navigation.closeFailed(record.navigation.beginClose())
        record.route?.let { route -> record.address?.let(route::beginClosing) }
        record.handle.navigationError = error
        record.handle.canRetryNavigationClose = true
        // 关闭失败继续保留 Surface/Session，可恢复后重试；不先清理再假装离栈。
        record.address?.let { navigationError(it, "", error) }
        diagnostic("navigation.closeFailed", record, (error as? URNContainerException)?.code ?: "NAVIGATION_FAILED")
        if (record.fragment?.get()?.context != null) runCatching {
            showOverlay(record, configuration.pageUI.navigationFailure(record.handle, error) { retryNavigationClose(record.handle) })
        }.onFailure { diagnostic("page.uiFailed", record, "UI_FACTORY_FAILED") }
    }

    private fun failPage(record: Record, error: Throwable, code: String, jsGone: Boolean = false) {
        if (record.finalClose) return
        record.failure = error
        record.handle.error = error
        record.handle.state = URNPageHandle.State.FAILED
        record.handle.canRetry = false
        if (record.pending == null) record.pending = record.mount
        completeReady(record, Result.failure(error))
        val retries = record.retryCallbacks.toList()
        record.retryCallbacks.clear()
        retries.forEach { runCatching { it(Result.failure(error)) } }
        showFailure(record)
        diagnostic("page.failed", record, code)
        beginClose(record, code, jsGone)
    }

    fun retry(page: URNPageHandle, completion: (Result<Unit>) -> Unit = {}) {
        dispatcher.checkThread()
        val record = records[page.id]
        if (record == null || !page.canRetry || record.barrier != null || record.finalClose) {
            completion(Result.failure(URNContainerException("RETRY_UNAVAILABLE", "页面尚不能重试")))
            return
        }
        record.failure = null
        page.error = null
        page.canRetry = false
        page.state = URNPageHandle.State.STARTING
        record.retryCallbacks.add(completion)
        showOverlay(record, configuration.pageUI.loading(page))
        mount(record)
    }

    fun retryCleanup(page: URNPageHandle, completion: (Result<Unit>) -> Unit = {}) {
        dispatcher.checkThread()
        val record = records[page.id]
        val barrier = record?.barrier
        if (record == null || barrier == null || !barrier.retry()) {
            completion(Result.failure(URNContainerException("CLEANUP_PENDING", "清理仍在进行，等待实际完成")))
            return
        }
        record.closeResult = null
        record.closeCallbacks.add(completion)
        if (!barrier.requiresCleanupRetry) { barrier.continueSurfaceRetry(); return }
        val cleanupAttempt = UUID.randomUUID().toString()
        record.cleanupAttempt = cleanupAttempt
        try { configuration.cleanup(page) { outcome -> dispatcher.execute {
            if (records[page.id] === record && record.cleanupAttempt == cleanupAttempt) barrier.cleanupCompleted(outcome)
        } } }
        catch (error: Exception) { barrier.cleanupCompleted(Result.failure(error)) }
    }

    private fun showFailure(record: Record) {
        val error = record.failure ?: return
        if (record.fragment?.get()?.context == null) return
        runCatching {
            showOverlay(record, configuration.pageUI.failure(record.handle, error, record.handle.canRetry) { retry(record.handle) })
        }.onFailure { diagnostic("page.uiFailed", record, "UI_FACTORY_FAILED") }
    }

    private fun showOverlay(record: Record, overlay: View?) {
        check(overlay == null || overlay === record.overlay || overlay.parent == null) { "覆盖视图必须由当前页面独占" }
        record.overlay?.let { (it.parent as? ViewGroup)?.removeView(it) }
        record.overlay = overlay
        val frame = record.pending?.frame ?: record.mount?.frame ?: return
        if (overlay != null) frame.addView(overlay, FrameLayout.LayoutParams(-1, -1))
    }

    private fun completeReady(record: Record, result: Result<URNPageHandle>) {
        val callback = record.readyCallback
        record.readyCallback = null
        runCatching { callback?.invoke(result) }
    }

    fun onHostResume(activity: Activity, backHandler: DefaultHardwareBackBtnHandler? = null) {
        dispatcher.checkThread()
        resumedActivity = WeakReference(activity)
        resumedBackHandler = backHandler?.let { WeakReference(it) }
        foreground = true
        runtime?.resume(activity, backHandler)
        records.values.toList().forEach(::publishLifecycle)
    }
    fun onHostPause(activity: Activity) {
        dispatcher.checkThread()
        if (resumedActivity?.get() !== activity) return
        foreground = false
        runtime?.pause(activity)
        records.values.toList().forEach(::publishLifecycle)
    }
    fun onHostDestroy(activity: Activity) {
        dispatcher.checkThread()
        permissionRequests.removeActivity(activity)
        if (resumedActivity?.get() !== activity) return
        foreground = false
        resumedActivity = null
        resumedBackHandler = null
        runtime?.activityDestroyed(activity)
    }
    fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        dispatcher.checkThread()
        runtime?.activityResult(activity, requestCode, resultCode, data)
    }
    fun onNewIntent(intent: Intent) { dispatcher.checkThread(); runtime?.newIntent(intent) }
    fun onWindowFocusChanged(hasFocus: Boolean) { dispatcher.checkThread(); runtime?.windowFocusChanged(hasFocus) }
    fun onConfigurationChanged(activity: Activity, configuration: Configuration) {
        dispatcher.checkThread()
        runtime?.configurationChanged(activity)
    }
    fun onUserLeaveHint(activity: Activity) { dispatcher.checkThread(); runtime?.userLeaveHint(activity) }
    fun onBackPressed(): Boolean { dispatcher.checkThread(); return runtime?.backPressed() ?: false }

    /** Activity 实现 PermissionAwareActivity 并委托本方法，让 RN 模块拿到实际权限结果。 */
    fun requestPermissions(activity: Activity, permissions: Array<String>, requestCode: Int, listener: PermissionListener) {
        dispatcher.checkThread()
        check(runtime?.isRetired == false && state != State.STOPPING && state != State.FAILED) { "RN Host 不再接收权限请求" }
        permissionRequests.put(requestCode, activity, listener)
        try { ActivityCompat.requestPermissions(activity, permissions, requestCode) }
        catch (error: Exception) { permissionRequests.remove(requestCode); throw error }
    }
    fun onRequestPermissionsResult(activity: Activity, requestCode: Int, permissions: Array<String>, grantResults: IntArray): Boolean {
        dispatcher.checkThread()
        val listener = permissionRequests.take(requestCode, activity) ?: return false
        if (runtime?.isRetired != false) return false
        return listener.onRequestPermissionsResult(requestCode, permissions, grantResults)
    }

    private fun diagnostic(stage: String, record: Record?, code: String?) {
        runCatching { configuration.onDiagnostic(stage, record?.handle?.id, code) }
        runCatching { configuration.onStructuredDiagnostic(URNDiagnostic(
            stage = stage, runtimeGeneration = generation, pageId = record?.handle?.id,
            channelId = record?.address?.channel,
            featureId = record?.handle?.featureId?.takeIf { configuration.diagnosticIncludesFeatureId },
            durationMs = record?.let { (System.nanoTime() - it.createdAtNanos) / 1_000_000 },
            queuedMessages = record?.address?.let { record.route?.queueSnapshot(it)?.messages },
            queuedBytes = record?.address?.let { record.route?.queueSnapshot(it)?.bytes }, code = code,
        )) }
    }
}
