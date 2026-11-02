import { assertJSON, utf8Size } from 'aeris-client-core/protocol';
import { URNError } from './URNError.js';
const ownerBindingsKey = Symbol.for('leo-urn.owner-provenance.v1');
const ownerBindingsHost = globalThis;
const restorationOwnerBindings = (ownerBindingsHost[ownerBindingsKey] ??= new WeakMap());
function canonical(value) {
    return JSON.stringify(value, (_key, raw) => raw && typeof raw === 'object' && !Array.isArray(raw)
        ? Object.fromEntries(Object.entries(raw).sort(([a], [b]) => a.localeCompare(b)))
        : raw);
}
function copyJSON(value, maxBytes = 16384) {
    assertJSON(value);
    const encoded = JSON.stringify(value);
    if (utf8Size(encoded) > maxBytes)
        throw new URNError('PAYLOAD_LIMIT', 'JSON超过预算');
    return JSON.parse(encoded);
}
/** Coordinator持有；每个异步请求都绑定页面epoch与用户域，关闭不转移清理责任。 */
export class ContainerCapabilities {
    options;
    ready = false;
    epoch = 0;
    sourceEpoch = new Map();
    domain = 'anonymous';
    entries = new Map();
    cancelling = new Set();
    cleanupTasks = new Map();
    routes = new Map();
    cleanup = new Set();
    nextCleanupOwner = 0;
    ownerBindings = restorationOwnerBindings;
    cleanupSources = new Map();
    failures = new Map();
    restoration;
    restorationState;
    constructor(options) {
        this.options = options;
        for (const number of [
            options.maxQueued ?? 16,
            options.timeoutMs ?? 15000,
            options.failureLimit ?? 3,
            options.failureWindowMs ?? 60000,
            options.cooldownMs ?? 30000,
            options.maxSnapshotPages ?? 16,
            options.maxSnapshotBytes ?? 262144,
        ])
            if (!Number.isSafeInteger(number) || number < 1 || number > 1048576)
                throw new URNError('INVALID_CONFIGURATION', '能力预算不合法');
        if (options.routes.length > 256)
            throw new URNError('INVALID_CONFIGURATION', '注册路由最多256项');
        for (const route of options.routes) {
            if (!/^\/[A-Za-z0-9/_-]{0,255}$/.test(route.path) || this.routes.has(route.path))
                throw new URNError('INVALID_ROUTE', '路由非法或重复');
            this.validateTarget(route.target);
            this.routes.set(route.path, Object.freeze({ ...route.target }));
        }
    }
    get userDomain() {
        return this.domain;
    }
    get pendingCleanupCount() {
        return this.cleanup.size;
    }
    setReady(ready) {
        this.ready = ready;
        if (ready)
            for (const entry of this.entries.values())
                this.start(entry);
    }
    validateTarget(target) {
        if (!target || !['native', 'rn', 'flutter', 'web'].includes(target.kind))
            throw new URNError('INVALID_ROUTE', '目标种类非法');
        const value = target.kind === 'rn' ? target.featureId : target.kind === 'web' ? target.url : target.route;
        if (typeof value !== 'string' || value.length < 1 || value.length > 2048)
            throw new URNError('INVALID_ROUTE', '目标缺失');
        if (target.kind === 'web' && !/^https?:\/\/[^\s]+$/.test(value))
            throw new URNError('INVALID_ROUTE', 'Web仅接受http/https');
    }
    open(url, options = {}) {
        let path, params;
        try {
            const parsed = new URL(url, 'urn://local');
            if (parsed.hash || parsed.username || parsed.password || url.length > 4096)
                throw Error();
            path = parsed.pathname;
            params = { ...Object.fromEntries(parsed.searchParams), ...options.params };
            params = copyJSON(params);
        }
        catch {
            throw new URNError('INVALID_ROUTE', '深链或参数不合法');
        }
        const target = this.routes.get(path);
        if (!target)
            throw new URNError('ROUTE_NOT_FOUND', '深链未注册');
        const key = canonical([options.source, path, params]);
        const existing = this.entries.get(key);
        if (existing)
            return existing.public;
        if (this.entries.size + this.cancelling.size + this.cleanup.size >=
            (this.options.maxQueued ?? 16))
            throw new URNError('ROUTE_LIMIT', '路由队列已满');
        let resolve, reject;
        const result = new Promise((yes, no) => {
            resolve = yes;
            reject = no;
        });
        const entry = {
            key,
            source: options.source,
            epoch: this.epoch,
            domain: this.domain,
            controller: new AbortController(),
            public: { result, cancel: () => this.cancel(entry) },
            resolve,
            reject,
            cancelled: false,
            settled: false,
        };
        const abort = () => {
            void this.cancel(entry).catch(() => { });
        };
        options.signal?.addEventListener('abort', abort, { once: true });
        const remove = () => {
            options.signal?.removeEventListener('abort', abort);
        };
        void result.then(remove, remove);
        entry.timer = setTimeout(() => {
            void this.cancel(entry, new URNError('ROUTE_TIMEOUT', '路由超过期限')).catch(() => { });
        }, this.options.timeoutMs ?? 15000);
        this.entries.set(key, entry);
        // 参数与目标按入队时快照保存，宿主后续修改不能改变正在执行的请求。
        Object.assign(entry, { target, params });
        if (options.signal?.aborted)
            abort();
        else if (this.ready)
            this.start(entry);
        return entry.public;
    }
    valid(entry) {
        return !entry.cancelled && entry.epoch === this.epoch && entry.domain === this.domain;
    }
    settle(entry, error, owner) {
        if (entry.settled)
            return;
        entry.settled = true;
        clearTimeout(entry.timer);
        this.entries.delete(entry.key);
        if (error !== undefined)
            entry.reject(error);
        else if (owner)
            entry.resolve(owner);
    }
    start(entry) {
        if (entry.work || !this.valid(entry))
            return;
        const { target, params } = entry;
        const context = {
            source: entry.source,
            signal: entry.controller.signal,
            userDomain: entry.domain,
        };
        entry.work = (async () => {
            try {
                if (this.options.guard && !(await this.options.guard(target, context)))
                    throw new URNError('ROUTE_DENIED', '宿主守卫拒绝路由');
                if (!this.valid(entry))
                    return;
                const failure = this.failures.get(JSON.stringify(target));
                if (failure && failure.until > Date.now())
                    throw new URNError('CIRCUIT_OPEN', '路由故障冷却中');
                entry.owner = await this.dispatchOperation(entry, target, params, context).result;
                if (!this.valid(entry)) {
                    this.cleanupSources.set(entry.owner, entry.source);
                    await this.release(entry.owner);
                    return;
                }
                this.settle(entry, undefined, entry.owner);
            }
            catch (error) {
                if (!this.valid(entry)) {
                    if (error instanceof URNError &&
                        ['OWNER_REUSED', 'OWNER_ALREADY_BOUND'].includes(error.code))
                        throw error;
                    if (entry.owner && this.cleanup.has(entry.owner))
                        throw error;
                    return;
                }
                if (error instanceof URNError &&
                    [
                        'CAPABILITY_MISSING',
                        'BASELINE_MISMATCH',
                        'INVALID_PARAMS',
                        'PERMISSION_DENIED',
                        'ROUTE_DENIED',
                        'OWNER_REUSED',
                        'OWNER_ALREADY_BOUND',
                    ].includes(error.code)) {
                    this.settle(entry, error);
                    return;
                }
                entry.operation = undefined;
                const key = JSON.stringify(target), now = Date.now();
                const window = this.options.failureWindowMs ?? 60000;
                for (const [candidate, history] of this.failures) {
                    history.times = history.times.filter((time) => now - time < window);
                    if (history.times.length === 0 && history.until <= now)
                        this.failures.delete(candidate);
                }
                if (!(error instanceof URNError && error.code === 'CIRCUIT_OPEN')) {
                    const limit = this.options.failureLimit ?? 3;
                    const failure = this.failures.get(key) ?? { times: [], until: 0 };
                    failure.times = [...(limit > 1 ? failure.times.slice(-(limit - 1)) : []), now];
                    if (failure.times.length >= limit)
                        failure.until = now + (this.options.cooldownMs ?? 30000);
                    this.failures.set(key, failure);
                }
                // 单次降级直接分发不同目标；不会递归重新进入失败路由。
                try {
                    const fallback = await this.options.fallback?.(target, error, context);
                    if (fallback && this.valid(entry)) {
                        this.validateTarget(fallback);
                        if (JSON.stringify(fallback) === JSON.stringify(target))
                            throw new URNError('RECURSIVE_FALLBACK', '降级不能重入同一目标');
                        entry.owner = await this.dispatchOperation(entry, fallback, params, context).result;
                        if (!this.valid(entry)) {
                            this.cleanupSources.set(entry.owner, entry.source);
                            await this.release(entry.owner);
                            return;
                        }
                        // 降级不把原始失败伪装成打开成功，owner交由取消/清理屏障释放。
                        this.cleanup.add(entry.owner);
                        this.cleanupSources.set(entry.owner, entry.source);
                    }
                }
                catch (fallbackError) {
                    error = fallbackError;
                }
                this.settle(entry, error);
            }
        })();
        void entry.work.catch((error) => this.settle(entry, error));
    }
    dispatchOperation(entry, target, params, context) {
        let assigned;
        entry.operationReady = new Promise((resolve) => {
            assigned = resolve;
        });
        try {
            const identity = this.compatibilityForTarget(target);
            const operation = this.options.dispatch(target, params, context);
            entry.operation = operation;
            return {
                cancel: () => operation.cancel(),
                result: operation.result.then((owner) => {
                    this.bindOwner(owner, {
                        baselineId: this.options.baselineId,
                        userDomain: entry.domain,
                        compatibility: identity,
                    }, false);
                    return owner;
                }),
            };
        }
        finally {
            assigned();
        }
    }
    cancel(entry, error = new URNError('CANCELLED', '路由已取消')) {
        if (entry.cancellation)
            return entry.cancellation;
        if (entry.settled && !entry.cancelled)
            return Promise.resolve();
        entry.cancelled = true;
        this.cancelling.add(entry);
        entry.controller.abort();
        this.settle(entry, error);
        const operationReady = entry.operationReady;
        const cancellation = Promise.resolve().then(async () => {
            await operationReady;
            const operation = entry.operation;
            if (!operation)
                return;
            let cancellationError;
            try {
                await operation.cancel();
            }
            catch (error) {
                cancellationError = error;
                const lease = {
                    id: `cancel-${++this.nextCleanupOwner}`,
                    close: () => operation.cancel(),
                };
                this.cleanup.add(lease);
                this.cleanupSources.set(lease, entry.source);
            }
            await entry.work;
            if (cancellationError)
                throw cancellationError;
        });
        entry.cancellation = cancellation;
        void cancellation.then(() => this.cancelling.delete(entry), () => this.cancelling.delete(entry));
        return cancellation;
    }
    release(owner) {
        const previous = this.cleanupTasks.get(owner);
        if (previous)
            return previous;
        this.cleanup.add(owner);
        const task = Promise.resolve()
            .then(() => owner.close())
            .then(() => {
            this.cleanup.delete(owner);
            this.cleanupSources.delete(owner);
        });
        this.cleanupTasks.set(owner, task);
        void task.then(() => this.cleanupTasks.delete(owner), () => this.cleanupTasks.delete(owner));
        return task;
    }
    async retryCleanup(source) {
        for (const owner of [...this.cleanup])
            if (source === undefined || this.cleanupSources.get(owner) === source)
                await this.release(owner);
    }
    async invalidate(source) {
        if (source === undefined)
            this.epoch++;
        else
            this.sourceEpoch.set(source, (this.sourceEpoch.get(source) ?? 0) + 1);
        const transaction = this.restorationState;
        const restoration = this.restoration;
        const tasks = [];
        if (transaction && restoration && (source === undefined || transaction.source === source)) {
            transaction.cancel();
            tasks.push(restoration.then(() => { }, (error) => {
                if (error instanceof URNError && error.code === 'RESTORE_ROLLBACK_FAILED')
                    throw error;
            }));
        }
        tasks.push(...[...this.entries.values(), ...this.cancelling]
            .filter((entry) => source === undefined || entry.source === source)
            .map((entry) => this.cancel(entry)));
        for (const owner of this.cleanup)
            if (source === undefined || this.cleanupSources.get(owner) === source)
                tasks.push(this.release(owner));
        const result = await Promise.allSettled(tasks);
        const failure = result.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected')
            throw failure.reason;
    }
    async setUserDomain(domain) {
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(domain))
            throw new URNError('INVALID_ENVIRONMENT', '用户域标识非法');
        if (domain === this.domain)
            return;
        this.domain = domain;
        await this.invalidate();
    }
    resetCircuit(target) {
        if (target)
            this.failures.delete(JSON.stringify(target));
        else
            this.failures.clear();
    }
    async capture(pages) {
        const epoch = this.epoch, domain = this.domain;
        if (pages.length > (this.options.maxSnapshotPages ?? 16))
            throw new URNError('SNAPSHOT_LIMIT', '快照页面过多');
        const values = [];
        for (const page of pages) {
            if (!this.routes.has(page.route))
                throw new URNError('ROUTE_NOT_FOUND', '快照路由未注册');
            const binding = this.ownerBindings.get(page.owner);
            if (!binding)
                throw new URNError('SNAPSHOT_OWNER_UNBOUND', '外部owner须由宿主显式登记创建用户域和路由');
            if (binding.baselineId !== this.options.baselineId)
                throw new URNError('SNAPSHOT_OWNER_INCOMPATIBLE', 'owner不属于当前容器基线');
            if (binding.userDomain !== domain)
                throw new URNError('SNAPSHOT_OWNER_DOMAIN_MISMATCH', '不能把旧用户owner重标为当前用户快照');
            if (canonical(binding.compatibility.target) !== canonical(this.routes.get(page.route)))
                throw new URNError('SNAPSHOT_OWNER_ROUTE_MISMATCH', 'owner不属于该快照路由');
            values.push({
                route: page.route,
                params: page.params,
                state: (await page.owner.capture?.()) ?? null,
                compatibility: binding.compatibility,
            });
            if (epoch !== this.epoch || domain !== this.domain)
                throw new URNError('CANCELLED', '快照期间所有权已改变');
        }
        return copyJSON({ version: 1, baselineId: this.options.baselineId, userDomain: domain, pages: values }, this.options.maxSnapshotBytes ?? 262144);
    }
    bindOwner(owner, binding, allowExisting) {
        const previous = this.ownerBindings.get(owner);
        if (previous) {
            if (allowExisting && canonical(previous) === canonical(binding))
                return;
            throw new URNError(allowExisting ? 'OWNER_ALREADY_BOUND' : 'OWNER_REUSED', 'owner创建域与模块身份不能重标或复用');
        }
        this.ownerBindings.set(owner, copyJSON(binding));
    }
    /** 外部owner由可信宿主显式证明创建域和路由；不能依赖capture时的当前用户自动补标。 */
    registerRestorationOwner(owner, registration) {
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(registration.userDomain))
            throw new URNError('INVALID_ENVIRONMENT', '创建用户域非法');
        const target = this.routes.get(registration.route);
        if (!target)
            throw new URNError('ROUTE_NOT_FOUND', '外部owner登记路由未注册');
        this.bindOwner(owner, {
            baselineId: this.options.baselineId,
            userDomain: registration.userDomain,
            compatibility: this.compatibilityForTarget(target),
        }, true);
    }
    compatibilityForTarget(target) {
        return copyJSON({ target, module: this.options.moduleIdentity?.(target) ?? null });
    }
    compatibility(route) {
        const target = this.routes.get(route);
        if (!target)
            throw new URNError('ROUTE_NOT_FOUND', '快照路由未注册');
        return this.compatibilityForTarget(target);
    }
    restore(read, options = {}) {
        if (this.restoration)
            return Promise.reject(new URNError('RESTORE_BUSY', '正在恢复'));
        let interrupt;
        const interrupted = new Promise((_resolve, reject) => {
            interrupt = reject;
        });
        const transaction = {
            source: options.source,
            interrupted,
            cancelled: false,
            cancel: () => {
                if (!transaction.cancelled) {
                    transaction.cancelled = true;
                    interrupt(new URNError('CANCELLED', '恢复来源已关闭或用户域改变'));
                }
            },
        };
        this.restorationState = transaction;
        const task = this.restoreTransaction(read, transaction);
        this.restoration = task;
        void task.then(() => {
            this.restoration = undefined;
            this.restorationState = undefined;
        }, () => {
            this.restoration = undefined;
            this.restorationState = undefined;
        });
        return task;
    }
    async restoreTransaction(read, transaction) {
        const source = transaction.source;
        const awaitOwned = (task) => Promise.race([task, transaction.interrupted]);
        const epoch = this.epoch, domain = this.domain;
        const sourceEpoch = source === undefined ? 0 : (this.sourceEpoch.get(source) ?? 0);
        const check = () => {
            if (transaction.cancelled ||
                epoch !== this.epoch ||
                domain !== this.domain ||
                (source !== undefined && sourceEpoch !== (this.sourceEpoch.get(source) ?? 0)))
                throw new URNError('CANCELLED', '恢复期间所有权已改变');
        };
        const created = [];
        try {
            const saved = await awaitOwned(read());
            check();
            let raw;
            try {
                raw = copyJSON(saved, this.options.maxSnapshotBytes ?? 262144);
            }
            catch {
                throw new URNError('SNAPSHOT_INCOMPATIBLE', '快照不是有界JSON');
            }
            check();
            if (!raw ||
                raw.version !== 1 ||
                raw.baselineId !== this.options.baselineId ||
                raw.userDomain !== domain ||
                !Array.isArray(raw.pages) ||
                raw.pages.length > (this.options.maxSnapshotPages ?? 16))
                throw new URNError('SNAPSHOT_INCOMPATIBLE', '快照损坏、跨用户域或基线不兼容');
            // 先验证整份快照，避免损坏尾页触发前面的真实UI创建。
            for (const page of raw.pages)
                if (!page ||
                    typeof page.route !== 'string' ||
                    !this.routes.has(page.route) ||
                    !page.params ||
                    typeof page.params !== 'object' ||
                    Array.isArray(page.params))
                    throw new URNError('SNAPSHOT_INCOMPATIBLE', '快照页面不合法');
            for (const page of raw.pages) {
                const identity = this.compatibility(page.route);
                // 无模块声明的旧快照可沿用baseline；一旦声明模块必须精确匹配版本与参数契约。
                const currentModule = identity.module;
                if ((page.compatibility !== undefined || currentModule !== null) &&
                    canonical(page.compatibility) !== canonical(identity))
                    throw new URNError('SNAPSHOT_INCOMPATIBLE', '模块版本、参数契约或路由目标已经变化');
            }
            for (const page of raw.pages) {
                check();
                transaction.current = this.open(page.route, {
                    params: page.params,
                    source: source ?? `restore-${epoch}-${created.length}`,
                });
                const owner = await awaitOwned(transaction.current.result);
                created.push(owner);
                check();
                if (!owner.restore && page.state !== null)
                    throw new URNError('RESTORE_UNAVAILABLE', '目标未提供业务恢复钩子');
                await awaitOwned(Promise.resolve(owner.restore?.(page.state)));
                check();
            }
            return Object.freeze(created);
        }
        catch (error) {
            const result = await Promise.allSettled([
                transaction.current?.cancel() ?? Promise.resolve(),
                ...created.reverse().map((owner) => {
                    this.cleanupSources.set(owner, source);
                    return this.release(owner);
                }),
            ]);
            if (result.some((value) => value.status === 'rejected'))
                throw new URNError('RESTORE_ROLLBACK_FAILED', '本轮恢复清理失败，owner已保留供retryCleanup');
            throw error;
        }
    }
}
