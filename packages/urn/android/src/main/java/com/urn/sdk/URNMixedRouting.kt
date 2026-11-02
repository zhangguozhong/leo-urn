package com.urn.sdk

import androidx.fragment.app.Fragment
import com.aeris.sdk.BridgeCancellation
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.net.URI
import java.net.URLDecoder
import java.util.IdentityHashMap
import java.util.UUID

sealed class URNRouteTarget {
    data class RN(val featureId: String) : URNRouteTarget()

    data class Native(val route: String) : URNRouteTarget()

    data class Flutter(val route: String) : URNRouteTarget()

    data class Web(val url: String) : URNRouteTarget() {
        init {
            require(URI(url).scheme?.lowercase() in setOf("http", "https"))
        }
    }
}

internal data class URNRestorationBinding(
    val userDomain: String,
    val modules: String,
    val target: URNRouteTarget,
)

class URNRouteOwner(
    val id: String,
    val page: URNPageHandle? = null,
    val close: ((Result<Unit>) -> Unit) -> Unit,
    val capture: ((Result<com.google.gson.JsonElement>) -> Unit) -> Unit = {
        it(Result.success(com.google.gson.JsonNull.INSTANCE))
    },
    val restore: (com.google.gson.JsonElement, (Result<Unit>) -> Unit) -> Unit = { state, done ->
        done(
            if (state.isJsonNull) Result.success(Unit)
            else Result.failure(URNContainerException("RESTORE_UNAVAILABLE", "未提供业务恢复钩子"))
        )
    },
) {
    internal var restorationBinding: URNRestorationBinding? = null
        private set

    internal fun bindRestoration(binding: URNRestorationBinding, allowExisting: Boolean) {
        restorationBinding?.let { previous ->
            if (allowExisting && previous == binding) return
            throw URNContainerException(
                if (allowExisting) "OWNER_ALREADY_BOUND" else "OWNER_REUSED",
                "owner创建域和模块身份不能重标或复用",
            )
        }
        restorationBinding = binding
    }
}

class URNRouteOperation(private val cancellation: ((Result<Unit>) -> Unit) -> Unit) {
    fun cancel(completion: (Result<Unit>) -> Unit = {}) = cancellation(completion)
}

data class URNMixedRouting(
    val routes: Map<String, URNRouteTarget>,
    val dispatch:
        (
            URNRouteTarget, JsonObject, Fragment, (Result<URNRouteOwner>) -> Unit,
        ) -> URNRouteOperation,
    val maxQueued: Int = 16,
    val timeoutMs: Long = 15000,
    val failureLimit: Int = 3,
    val failureWindowMs: Long = 60000,
    val cooldownMs: Long = 30000,
    val guard: (URNRouteTarget, Fragment, (Result<Boolean>) -> Unit) -> Unit = { _, _, done ->
        done(Result.success(true))
    },
    val fallback: (URNRouteTarget, Throwable, (URNRouteTarget?) -> Unit) -> Unit = { _, _, done ->
        done(null)
    },
) {
    init {
        require(
            maxQueued in 1..64 &&
                timeoutMs in 1..300000 &&
                failureLimit in 1..100 &&
                failureWindowMs > 0 &&
                cooldownMs > 0
        )
        require(routes.size <= 256)
        require(routes.keys.all { Regex("^/[A-Za-z0-9/_-]{0,255}$").matches(it) })
    }
}

data class URNRestorableRoute(
    val route: String,
    val params: JsonObject = JsonObject(),
    val owner: URNRouteOwner,
)

internal class URNMixedRouter(
    configuration: URNMixedRouting,
    private val schedule: (Long, () -> Unit) -> BridgeCancellation,
    private val post: (() -> Unit) -> Unit,
    private val ownerActive: (Fragment) -> Boolean = {
        it.isAdded && it.lifecycle.currentState != androidx.lifecycle.Lifecycle.State.DESTROYED
    },
    private val moduleIdentity: () -> String = { "" },
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val configuration = configuration.copy(routes = configuration.routes.toMap())

    private class Entry(
        val key: String,
        val source: String?,
        val epoch: String,
        val domain: String,
        val target: URNRouteTarget,
        val params: JsonObject,
        val fragment: Fragment,
    ) {
        val id = UUID.randomUUID().toString()
        var settled = false
        var cancelled = false
        var dispatched = false
        var dispatching = false
        var cancellationStarted = false
        var operation: URNRouteOperation? = null
        var owner: URNRouteOwner? = null
        var deadline: BridgeCancellation? = null
        val callbacks = mutableListOf<(Result<URNRouteOwner>) -> Unit>()
        val cancelCallbacks = mutableListOf<(Result<Unit>) -> Unit>()
        var cancellationResult: Result<Unit>? = null
        var cancelOperationResult: Result<Unit>? = null
        var dispatchCleanupResult: Result<Unit>? = null
    }

    private var epoch = UUID.randomUUID().toString()
    private var domain = "anonymous"
    private var ready = true
    private var restoring = false
    private var restoreSource: String? = null
    private var restoreCancelled = false
    private var cancelRestore: (((Result<Unit>) -> Unit) -> Unit)? = null
    private val cancelling = linkedMapOf<String, Entry>()
    private val cleanupSources = IdentityHashMap<URNRouteOwner, String?>()
    private val releasing = IdentityHashMap<URNRouteOwner, MutableList<(Result<Unit>) -> Unit>>()
    private val entries = linkedMapOf<String, Entry>()
    private val cleanup = IdentityHashMap<URNRouteOwner, URNRouteOwner>()
    private val failures = mutableMapOf<URNRouteTarget, MutableList<Long>>()
    private val blockedUntil = mutableMapOf<URNRouteTarget, Long>()
    val pendingCleanupCount
        get() = cleanup.size

    fun setReady(value: Boolean) {
        ready = value
        if (value) entries.values.toList().forEach(::run)
    }

    fun setDomain(value: String) {
        if (value != domain) {
            domain = value
            invalidate()
        }
    }

    fun invalidate(source: String? = null, completion: (Result<Unit>) -> Unit = {}) {
        if (source == null) epoch = UUID.randomUUID().toString()
        if (source == null || (restoring && source == restoreSource)) restoreCancelled = true
        val selected =
            (entries.values + cancelling.values)
                .filter { source == null || source == it.source }
                .distinctBy { it.id }
        val owners =
            cleanup.values.filter { source == null || cleanupSources[it] == source }.toList()
        val restoreCancellation =
            if (source == null || source == restoreSource) cancelRestore else null
        var left = selected.size + owners.size + if (restoreCancellation == null) 0 else 1
        var failure: Throwable? = null
        if (left == 0) {
            completion(Result.success(Unit))
            return
        }
        fun done(result: Result<Unit>) {
            failure = result.exceptionOrNull() ?: failure
            if (--left == 0) completion(failure?.let { Result.failure(it) } ?: Result.success(Unit))
        }
        restoreCancellation?.invoke(::done)
        selected.forEach { cancel(it, completion = ::done) }
        owners.forEach { release(it, ::done) }
    }

    private fun valid(entry: Entry) =
        !entry.cancelled && entry.epoch == epoch && entry.domain == domain

    fun open(
        url: String,
        params: JsonObject,
        source: String?,
        from: Fragment,
        completion: (Result<URNRouteOwner>) -> Unit,
    ): URNRouteOperation {
        val uri = URI(url)
        require(url.length <= 4096 && uri.fragment == null && uri.userInfo == null) {
            "INVALID_ROUTE"
        }
        val target =
            configuration.routes[uri.path]
                ?: throw URNContainerException("ROUTE_NOT_FOUND", "深链未注册")
        val merged = JsonObject()
        uri.rawQuery?.split("&")?.forEach { item ->
            val parts = item.split("=", limit = 2)
            merged.addProperty(
                URLDecoder.decode(parts[0], "UTF-8"),
                URLDecoder.decode(parts.getOrElse(1) { "" }, "UTF-8"),
            )
        }
        params.entrySet().forEach { merged.add(it.key, it.value.deepCopy()) }
        require(merged.toString().toByteArray().size <= 16384) { "INVALID_PARAMS" }
        val canonical =
            JsonObject().apply {
                merged.entrySet().sortedBy { it.key }.forEach { add(it.key, it.value) }
            }
        val key = "$source:${uri.path}:$canonical"
        entries[key]?.let { existing ->
            existing.callbacks.add(completion)
            return URNRouteOperation { cancel(existing, completion = it) }
        }
        check(entries.size + cleanup.size + cancelling.size < configuration.maxQueued) {
            "ROUTE_LIMIT"
        }
        val entry = Entry(key, source, epoch, domain, target, merged, from)
        entry.callbacks.add(completion)
        entries[key] = entry
        entry.deadline =
            schedule(configuration.timeoutMs) {
                cancel(entry, URNContainerException("ROUTE_TIMEOUT", "路由超过期限")) {}
            }
        if (ready) run(entry)
        return URNRouteOperation { cancel(entry, completion = it) }
    }

    private fun settle(entry: Entry, result: Result<URNRouteOwner>) {
        if (entry.settled) return
        entry.settled = true
        entry.deadline?.cancel()
        entries.remove(entry.key)
        val callbacks = entry.callbacks.toList()
        entry.callbacks.clear()
        callbacks.forEach { runCatching { it(result) } }
    }

    private fun run(entry: Entry) {
        if (!valid(entry) || entry.dispatched) return
        entry.dispatched = true
        var responded = false
        try {
            configuration.guard(entry.target, entry.fragment) { result ->
                post {
                    if (responded || !valid(entry)) return@post
                    responded = true
                    result.fold(
                        onSuccess = { allowed ->
                            if (!allowed)
                                settle(
                                    entry,
                                    Result.failure(URNContainerException("ROUTE_DENIED", "宿主拒绝路由")),
                                )
                            else if ((blockedUntil[entry.target] ?: 0) > clock())
                                failed(entry, URNContainerException("CIRCUIT_OPEN", "路由熔断冷却中"))
                            else dispatch(entry, entry.target, null)
                        },
                        onFailure = { settle(entry, Result.failure(it)) },
                    )
                }
            }
        } catch (error: Exception) {
            failed(entry, error)
        }
    }

    private fun dispatch(entry: Entry, target: URNRouteTarget, fallbackError: Throwable?) {
        var responded = false
        entry.dispatching = true
        try {
            val operation =
                configuration.dispatch(target, entry.params.deepCopy(), entry.fragment) { result ->
                    post {
                        if (responded) return@post
                        responded = true
                        entry.operation = null
                        result.fold(
                            onSuccess = { owner ->
                                try {
                                    owner.bindRestoration(
                                        URNRestorationBinding(
                                            entry.domain,
                                            moduleIdentity(),
                                            target,
                                        ),
                                        false,
                                    )
                                } catch (error: Exception) {
                                    if (entry.cancelled) {
                                        entry.dispatchCleanupResult = Result.failure(error)
                                        tryFinishCancel(entry)
                                    } else settle(entry, Result.failure(error))
                                    return@fold
                                }
                                entry.owner = owner
                                if (!valid(entry)) {
                                    cleanupSources[owner] = entry.source
                                    release(owner) {
                                        entry.dispatchCleanupResult = it
                                        tryFinishCancel(entry)
                                    }
                                } else if (fallbackError != null) {
                                    cleanupSources[owner] = entry.source
                                    cleanup[owner] = owner
                                    settle(entry, Result.failure(fallbackError))
                                } else settle(entry, Result.success(owner))
                            },
                            onFailure = { error ->
                                if (entry.cancelled) {
                                    entry.dispatchCleanupResult = Result.success(Unit)
                                    tryFinishCancel(entry)
                                } else if (fallbackError != null)
                                    settle(entry, Result.failure(error))
                                else failed(entry, error)
                            },
                        )
                    }
                }
            entry.dispatching = false
            if (!responded) entry.operation = operation
            if (entry.cancelled) cancelOperation(entry, operation)
        } catch (error: Exception) {
            entry.dispatching = false
            if (entry.cancelled) finishCancel(entry, Result.failure(error))
            else if (fallbackError != null) settle(entry, Result.failure(error))
            else failed(entry, error)
        }
    }

    private fun failed(entry: Entry, error: Throwable) {
        if (!valid(entry)) return
        if (
            error is URNContainerException &&
                error.code in
                    setOf(
                        "CAPABILITY_MISSING",
                        "BASELINE_MISMATCH",
                        "INVALID_PARAMS",
                        "PERMISSION_DENIED",
                        "ROUTE_DENIED",
                    )
        ) {
            settle(entry, Result.failure(error))
            return
        }
        val now = clock()
        failures.keys.toList().forEach { candidate ->
            val recent =
                failures[candidate]
                    ?.filter { now - it < configuration.failureWindowMs }
                    ?.toMutableList() ?: mutableListOf()
            if (recent.isEmpty() && (blockedUntil[candidate] ?: 0) <= now) {
                failures.remove(candidate)
                blockedUntil.remove(candidate)
            } else failures[candidate] = recent
        }
        if (error !is URNContainerException || error.code != "CIRCUIT_OPEN") {
            val times =
                (failures[entry.target]?.takeLast(configuration.failureLimit - 1) ?: emptyList())
                    .toMutableList()
            times.add(now)
            failures[entry.target] = times
            if (times.size >= configuration.failureLimit)
                blockedUntil[entry.target] = now + configuration.cooldownMs
        }
        var responded = false
        try {
            configuration.fallback(entry.target, error) { target ->
                post {
                    if (responded || !valid(entry)) return@post
                    responded = true
                    if (target != null && target != entry.target) dispatch(entry, target, error)
                    else settle(entry, Result.failure(error))
                }
            }
        } catch (failure: Exception) {
            settle(entry, Result.failure(failure))
        }
    }

    private fun cancel(
        entry: Entry,
        error: Throwable = URNContainerException("CANCELLED", "路由已取消"),
        completion: (Result<Unit>) -> Unit,
    ) {
        entry.cancellationResult?.let {
            completion(it)
            return
        }
        if (entry.settled && !entry.cancelled) {
            completion(Result.success(Unit))
            return
        }
        entry.cancelCallbacks.add(completion)
        if (entry.cancelled) return
        entry.cancelled = true
        cancelling[entry.id] = entry
        settle(entry, Result.failure(error))
        val operation = entry.operation
        if (operation != null) cancelOperation(entry, operation)
        else if (!entry.dispatching) finishCancel(entry, Result.success(Unit))
    }

    private fun cancelOperation(entry: Entry, operation: URNRouteOperation) {
        if (entry.cancellationStarted) return
        entry.cancellationStarted = true
        operation.cancel { result ->
            post {
                entry.cancelOperationResult = result
                if (result.isFailure) {
                    val lease =
                        URNRouteOwner("cancel:${entry.id}", close = { operation.cancel(it) })
                    cleanup[lease] = lease
                    cleanupSources[lease] = entry.source
                }
                tryFinishCancel(entry)
            }
        }
    }

    private fun tryFinishCancel(entry: Entry) {
        val cancellation = entry.cancelOperationResult ?: return
        val cleanup = entry.dispatchCleanupResult ?: return
        finishCancel(entry, if (cancellation.isFailure) cancellation else cleanup)
    }

    private fun finishCancel(entry: Entry, result: Result<Unit>) {
        if (entry.cancellationResult != null) return
        entry.cancellationResult = result
        cancelling.remove(entry.id)
        val callbacks = entry.cancelCallbacks.toList()
        entry.cancelCallbacks.clear()
        callbacks.forEach { runCatching { it(result) } }
    }

    private fun release(owner: URNRouteOwner, completion: (Result<Unit>) -> Unit) {
        cleanup[owner] = owner
        releasing[owner]?.let {
            it.add(completion)
            return
        }
        releasing[owner] = mutableListOf(completion)
        var responded = false
        fun finish(result: Result<Unit>) {
            if (responded) return
            responded = true
            if (result.isSuccess) {
                cleanup.remove(owner)
                cleanupSources.remove(owner)
            }
            val callbacks = releasing.remove(owner)?.toList() ?: emptyList()
            callbacks.forEach { it(result) }
        }
        try {
            owner.close { result -> post { finish(result) } }
        } catch (error: Exception) {
            finish(Result.failure(error))
        }
    }

    fun retryCleanup(source: String? = null, completion: (Result<Unit>) -> Unit) {
        val owners =
            cleanup.values.filter { source == null || cleanupSources[it] == source }.toList()
        var left = owners.size
        var failure: Throwable? = null
        if (left == 0) {
            completion(Result.success(Unit))
            return
        }
        owners.forEach {
            release(it) { result ->
                failure = result.exceptionOrNull() ?: failure
                if (--left == 0)
                    completion(failure?.let { Result.failure(it) } ?: Result.success(Unit))
            }
        }
    }

    fun resetCircuit() {
        failures.clear()
        blockedUntil.clear()
    }

    fun registerRestorationOwner(owner: URNRouteOwner, userDomain: String, route: String) {
        require(Regex("^[A-Za-z0-9._-]{1,128}$").matches(userDomain)) {
            "INVALID_RESTORATION_OWNER"
        }
        val target =
            configuration.routes[route]
                ?: throw URNContainerException("ROUTE_NOT_FOUND", "外部owner登记路由未注册")
        owner.bindRestoration(URNRestorationBinding(userDomain, moduleIdentity(), target), true)
    }

    fun capture(
        pages: List<URNRestorableRoute>,
        baseline: String,
        modules: String,
        completion: (Result<String>) -> Unit,
    ) {
        val token = epoch
        val user = domain
        val values = JsonArray()
        if (pages.size > 16) {
            completion(Result.failure(URNContainerException("SNAPSHOT_LIMIT", "快照页面超过预算")))
            return
        }
        fun next(index: Int) {
            if (token != epoch || user != domain) {
                completion(Result.failure(URNContainerException("CANCELLED", "捕获期间用户域或轮次改变")))
                return
            }
            if (index == pages.size) {
                val data =
                    JsonObject()
                        .apply {
                            addProperty("version", 1)
                            addProperty("baselineId", baseline)
                            addProperty("modules", modules)
                            addProperty("userDomain", user)
                            add("pages", values)
                        }
                        .toString()
                completion(
                    if (data.toByteArray().size <= 262144) Result.success(data)
                    else Result.failure(URNContainerException("SNAPSHOT_LIMIT", "快照超过256KB"))
                )
                return
            }
            val page = pages[index]
            val target = configuration.routes[page.route]
            if (target == null) {
                completion(Result.failure(URNContainerException("ROUTE_NOT_FOUND", "快照路由未注册")))
                return
            }
            val binding = page.owner.restorationBinding
            if (binding == null) {
                completion(
                    Result.failure(
                        URNContainerException("SNAPSHOT_OWNER_UNBOUND", "外部owner须由宿主显式登记创建域")
                    )
                )
                return
            }
            if (binding.userDomain != user) {
                completion(
                    Result.failure(
                        URNContainerException(
                            "SNAPSHOT_OWNER_DOMAIN_MISMATCH",
                            "不能把旧用户owner重标为当前用户快照",
                        )
                    )
                )
                return
            }
            if (binding.modules != modules || binding.target != target) {
                completion(
                    Result.failure(
                        URNContainerException("SNAPSHOT_OWNER_INCOMPATIBLE", "owner不属于当前模块版本或路由")
                    )
                )
                return
            }
            var responded = false
            page.owner.capture { result ->
                post {
                    if (!responded) {
                        responded = true
                        result.fold(
                            onSuccess = { state ->
                                values.add(
                                    JsonObject().apply {
                                        addProperty("route", page.route)
                                        add("params", page.params.deepCopy())
                                        add("state", state.deepCopy())
                                    }
                                )
                                next(index + 1)
                            },
                            onFailure = { completion(Result.failure(it)) },
                        )
                    }
                }
            }
        }
        next(0)
    }

    fun restore(
        read: ((Result<String>) -> Unit) -> Unit,
        baseline: String,
        modules: String,
        from: Fragment,
        sourcePageId: String?,
        completion: (Result<List<URNRouteOwner>>) -> Unit,
    ) {
        if (restoring) {
            completion(Result.failure(URNContainerException("RESTORE_BUSY", "正在恢复快照")))
            return
        }
        restoring = true
        restoreSource = sourcePageId
        restoreCancelled = false
        val token = epoch
        val user = domain
        val created = mutableListOf<URNRouteOwner>()
        var completed = false
        var rollingBack = false
        val cancellationCallbacks = mutableListOf<(Result<Unit>) -> Unit>()
        fun valid() =
            !completed && token == epoch && user == domain && !restoreCancelled && ownerActive(from)
        fun finish(result: Result<List<URNRouteOwner>>) {
            if (completed) return
            completed = true
            restoring = false
            cancelRestore = null
            val error = result.exceptionOrNull()
            val cleanupResult =
                if (error is URNContainerException && error.code == "RESTORE_ROLLBACK_FAILED")
                    Result.failure<Unit>(error)
                else Result.success(Unit)
            cancellationCallbacks.toList().forEach { it(cleanupResult) }
            cancellationCallbacks.clear()
            completion(result)
        }
        fun rollback(error: Throwable) {
            if (completed || rollingBack) return
            rollingBack = true
            var left = created.size
            var failed = false
            if (left == 0) {
                finish(Result.failure(error))
                return
            }
            created.reversed().forEach {
                cleanupSources[it] = sourcePageId
                release(it) { result ->
                    if (result.isFailure) failed = true
                    if (--left == 0)
                        finish(
                            Result.failure(
                                if (failed)
                                    URNContainerException(
                                        "RESTORE_ROLLBACK_FAILED",
                                        "回滚清理失败，owner保留供重试",
                                    )
                                else error
                            )
                        )
                }
            }
        }
        cancelRestore = { done ->
            cancellationCallbacks.add(done)
            restoreCancelled = true
            rollback(URNContainerException("CANCELLED", "来源页面已关闭或用户域已改变"))
        }
        var readDone = false
        try {
            read { result ->
                post {
                    if (readDone || completed) return@post
                    readDone = true
                    if (!valid()) {
                        rollback(URNContainerException("CANCELLED", "读取期间用户域或轮次改变"))
                        return@post
                    }
                    try {
                        val text = result.getOrThrow()
                        require(text.toByteArray().size <= 262144)
                        val raw = JsonParser.parseString(text).asJsonObject
                        require(
                            raw.get("version")?.asInt == 1 &&
                                raw.get("baselineId")?.asString == baseline &&
                                raw.get("modules")?.asString == modules &&
                                raw.get("userDomain")?.asString == user
                        )
                        val pages = raw.getAsJsonArray("pages")
                        require(pages.size() <= 16)
                        pages.forEach {
                            val page = it.asJsonObject
                            require(
                                page.get("route")?.asString in configuration.routes &&
                                    page.get("params")?.isJsonObject == true &&
                                    page.has("state")
                            )
                        }
                        fun next(index: Int) {
                            if (!valid()) {
                                rollback(URNContainerException("CANCELLED", "恢复期间用户域或轮次改变"))
                                return
                            }
                            if (index == pages.size()) {
                                finish(Result.success(created.toList()))
                                return
                            }
                            val page = pages[index].asJsonObject
                            try {
                                open(
                                    page.get("route").asString,
                                    page.getAsJsonObject("params"),
                                    sourcePageId ?: "restore-$token-$index",
                                    from,
                                ) { outcome ->
                                    outcome.fold(
                                        onSuccess = { owner ->
                                            created.add(owner)
                                            if (!valid()) {
                                                rollback(
                                                    URNContainerException(
                                                        "CANCELLED",
                                                        "恢复期间用户域或轮次改变",
                                                    )
                                                )
                                                return@fold
                                            }
                                            var applied = false
                                            try {
                                                owner.restore(page.get("state")) { appliedResult ->
                                                    post {
                                                        if (!applied) {
                                                            applied = true
                                                            appliedResult.fold(
                                                                onSuccess = { next(index + 1) },
                                                                onFailure = ::rollback,
                                                            )
                                                        }
                                                    }
                                                }
                                            } catch (error: Exception) {
                                                rollback(error)
                                            }
                                        },
                                        onFailure = ::rollback,
                                    )
                                }
                            } catch (error: Exception) {
                                rollback(error)
                            }
                        }
                        next(0)
                    } catch (error: Exception) {
                        rollback(
                            URNContainerException("SNAPSHOT_INCOMPATIBLE", "快照损坏或与用户域、模块版本、基线不兼容")
                        )
                    }
                }
            }
        } catch (error: Exception) {
            rollback(error)
        }
    }
}
