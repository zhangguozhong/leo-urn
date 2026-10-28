import { ChannelDispatcher, validIdentity } from './ChannelDispatcher.js';
import { ContainerClient } from './ContainerClient.js';
import { URNError } from './URNError.js';
import { channelBudgetDefaults } from './ChannelBudgetDefaults.js';
import { publishDiagnostic } from './Diagnostic.js';
export function readContext(value) {
    if (!value || typeof value !== 'object')
        throw new URNError('INVALID_CONTEXT', '缺少页面上下文');
    const context = value;
    if (!validIdentity(context.pageId) ||
        !validIdentity(context.channelId) ||
        !validIdentity(context.runtimeGeneration) ||
        !validIdentity(context.baselineId)) {
        throw new URNError('INVALID_CONTEXT', '页面上下文字段缺失或超长');
    }
    return {
        pageId: context.pageId,
        channelId: context.channelId,
        runtimeGeneration: context.runtimeGeneration,
        baselineId: context.baselineId,
    };
}
function budgetIdentity(options) {
    return JSON.stringify({
        maxChannels: options.maxChannels ?? channelBudgetDefaults.legacyJsMaxChannels,
        maxRetiredChannels: options.maxRetiredChannels ?? channelBudgetDefaults.maxRetiredChannels,
        maxQueuedMessages: options.maxQueuedMessages ?? channelBudgetDefaults.jsPageMessages,
        maxQueuedBytes: options.maxQueuedBytes ?? channelBudgetDefaults.jsPageBytes,
        maxFrameBytes: options.maxFrameBytes ?? channelBudgetDefaults.maxFrameBytes,
    });
}
/** 所有权属于原生页面；React effect cleanup 只撤销观察，不销毁 Client。 */
export class PageCoordinator {
    runtimeGeneration;
    lifecycle;
    dispatcher;
    pages = new Map();
    closed = new Map();
    closing = new Map();
    ignoredClose = Promise.resolve();
    rootCommits = new Map();
    maxRootCommits;
    readyPages = new WeakSet();
    contentPages = new WeakSet();
    maxRetired;
    closeSubscription;
    pageSubscription;
    ended = false;
    ending;
    configuration;
    revision = 0;
    observers = new Set();
    budgetSignature;
    pageStarted = new Map();
    getSnapshot = () => this.revision;
    subscribe = (observer) => {
        this.observers.add(observer);
        return () => {
            this.observers.delete(observer);
        };
    };
    constructor(runtimeGeneration, channel, lifecycle, configuration, options = {}) {
        this.runtimeGeneration = runtimeGeneration;
        this.lifecycle = lifecycle;
        this.configuration = configuration;
        this.budgetSignature = budgetIdentity(options);
        this.maxRetired = options.maxRetiredChannels ?? channelBudgetDefaults.maxRetiredChannels;
        this.maxRootCommits =
            this.maxRetired + (options.maxChannels ?? channelBudgetDefaults.legacyJsMaxChannels);
        this.dispatcher = new ChannelDispatcher(runtimeGeneration, channel, {
            ...options,
            onError: (error) => this.reportError(error),
            onDiagnostic: (event) => publishDiagnostic(this.configuration.onDiagnostic, event),
        });
        try {
            this.pageSubscription = lifecycle.onPageEvent?.((event) => {
                try {
                    if (this.ended ||
                        event.runtimeGeneration !== this.runtimeGeneration ||
                        typeof event.message !== 'string' ||
                        event.message.length > 32768)
                        return;
                    const client = this.pages.get(event.channelId);
                    if (!client?.active)
                        return;
                    try {
                        client.experience.receive(JSON.parse(event.message));
                    }
                    catch (error) {
                        this.reportError(error);
                    }
                }
                finally {
                    this.dispatcher.acknowledge(event);
                }
            });
            this.closeSubscription = lifecycle.onCloseRequested((event) => {
                try {
                    if (this.ended || event.runtimeGeneration !== this.runtimeGeneration)
                        return;
                    if (!validIdentity(event.channelId))
                        return;
                    void this.close(event.channelId);
                }
                finally {
                    this.dispatcher.acknowledge(event);
                }
            });
        }
        catch (error) {
            this.pageSubscription?.remove();
            this.dispatcher.close();
            throw error;
        }
    }
    update(configuration, budget) {
        if (budget && budgetIdentity(budget) !== this.budgetSignature)
            throw new URNError('BUDGET_MISMATCH', '同一运行轮次不能替换预算');
        if (configuration.baselineId !== this.configuration.baselineId) {
            throw new URNError('BASELINE_MISMATCH', 'FastRefresh 不能替换运行时基线');
        }
        this.configuration = configuration;
        this.revision++;
        for (const observer of this.observers)
            this.notify(observer);
    }
    reportError(error) {
        try {
            this.configuration.onError?.(error);
        }
        catch {
            // 宿主诊断代码不拥有页面生命周期。
        }
    }
    diagnostic(stage, channelId, durationMs) {
        const root = this.rootCommits.get(channelId);
        publishDiagnostic(this.configuration.onDiagnostic, {
            stage,
            runtimeGeneration: this.runtimeGeneration,
            channelId,
            ...(root ? { pageId: root.context.pageId } : {}),
            ...(root && this.configuration.includeFeatureIdsInDiagnostics
                ? { featureId: root.featureId }
                : {}),
            ...(durationMs === undefined ? {} : { durationMs: Math.max(0, durationMs) }),
        });
    }
    prepare(props) {
        if (this.ended)
            throw new URNError('DISCONNECTED', '运行时已结束');
        const context = readContext(props?.containerContext);
        if (context.runtimeGeneration !== this.runtimeGeneration) {
            throw new URNError('STALE_GENERATION', '页面不属于当前原生轮次');
        }
        if (context.baselineId !== this.configuration.baselineId) {
            throw new URNError('BASELINE_MISMATCH', '页面基线与注册表不同');
        }
        if (this.closed.has(context.channelId))
            throw new URNError('CHANNEL_RETIRED', '页面已退役');
        if (typeof props.featureId !== 'string')
            throw new URNError('INVALID_FEATURE', '缺少业务标识');
        const root = this.rootCommits.get(context.channelId);
        if (root && !this.matchesRoot(root, props, context)) {
            throw new URNError('CHANNEL_OWNED', '根视图已属于另一个页面');
        }
        const feature = this.configuration.registry.resolve(props.featureId, props.params);
        let client = this.pages.get(context.channelId);
        if (client) {
            if (!this.matchesPage(client, props, context)) {
                throw new URNError('CHANNEL_OWNED', '通道已属于另一个页面');
            }
            if (!client.active)
                throw new URNError('CHANNEL_RETIRED', '页面已退役');
        }
        else {
            if ([...this.pages.values()].some((page) => page.pageId === context.pageId && page.active)) {
                throw new URNError('PAGE_OWNED', '页面不能同时使用两个通道');
            }
            if (!this.rootCommits.has(context.channelId) &&
                this.rootCommits.size >= this.maxRootCommits) {
                throw new URNError('RETIREMENT_CAPACITY', '当前轮次根视图记录已满');
            }
            const port = this.dispatcher.open(context.channelId);
            if (!root)
                this.rootCommits.set(context.channelId, {
                    context,
                    featureId: props.featureId,
                    mounted: false,
                });
            client = new ContainerClient(context.pageId, props.featureId, port, (e) => this.reportError(e), (command, id, payload) => {
                if (!lifecycleCommandAvailable(this.lifecycle))
                    throw new URNError('NAVIGATION_UNAVAILABLE', '原生导航未接入');
                this.lifecycle.command(this.runtimeGeneration, context.channelId, command, id, payload);
            });
            this.pages.set(context.channelId, client);
            this.pageStarted.set(context.channelId, performance.now());
            this.diagnostic('client.created', context.channelId);
            port.onClose(() => {
                void this.close(context.channelId);
            });
        }
        return { client, feature };
    }
    matchesPage(client, props, context) {
        return (client.pageId === context.pageId &&
            client.featureId === props.featureId &&
            client.port.channelId === context.channelId &&
            context.runtimeGeneration === this.runtimeGeneration &&
            context.baselineId === this.configuration.baselineId);
    }
    owns(client) {
        return !this.ended && client.active && this.pages.get(client.port.channelId) === client;
    }
    matchesRoot(root, props, context) {
        return (root.context.pageId === context.pageId &&
            root.context.channelId === context.channelId &&
            root.context.runtimeGeneration === context.runtimeGeneration &&
            root.context.baselineId === context.baselineId &&
            root.featureId === props.featureId);
    }
    notifyMounted(channelId, root) {
        if (root.mounted)
            return;
        root.mounted = true;
        this.notify(() => this.lifecycle.mounted(this.runtimeGeneration, channelId));
    }
    rootMounted(props) {
        if (this.ended)
            return;
        let context;
        try {
            context = readContext(props?.containerContext);
        }
        catch {
            return;
        }
        // mounted 只确认物理 Root 已提交；业务基线由 prepare 单独严格校验。
        if (context.runtimeGeneration !== this.runtimeGeneration || !validIdentity(props.featureId))
            return;
        const owner = this.pages.get(context.channelId);
        if (owner && !this.matchesPage(owner, props, context))
            return;
        let root = this.rootCommits.get(context.channelId);
        if (root) {
            if (!this.matchesRoot(root, props, context))
                return;
        }
        else {
            // 最多保留退役预算加活动页面预算；不淘汰身份后重新发送 mounted。
            if (this.rootCommits.size >= this.maxRootCommits)
                return;
            root = { context, featureId: props.featureId, mounted: false };
            this.rootCommits.set(context.channelId, root);
        }
        // 空 Root 也已真实提交；与 Client 是否存在、是否已 disposed 无关。
        this.notifyMounted(context.channelId, root);
    }
    mounted(client) {
        if (!this.owns(client))
            return;
        const root = this.rootCommits.get(client.port.channelId);
        if (root)
            this.notifyMounted(client.port.channelId, root);
    }
    async reportReady(client) {
        await client.ready();
        if (!this.owns(client) || this.readyPages.has(client))
            return;
        this.readyPages.add(client);
        this.diagnostic('client.ready', client.port.channelId, performance.now() - (this.pageStarted.get(client.port.channelId) ?? performance.now()));
        this.notify(() => this.lifecycle.bridgeReady?.(this.runtimeGeneration, client.port.channelId));
    }
    /** 业务子树成功提交后调用；握手、Suspense 等待和失败都不能提前结束加载。 */
    reportContentReady(client) {
        if (!this.owns(client) ||
            !client.active ||
            !this.readyPages.has(client) ||
            this.contentPages.has(client))
            return;
        this.contentPages.add(client);
        this.diagnostic('content.ready', client.port.channelId, performance.now() - (this.pageStarted.get(client.port.channelId) ?? performance.now()));
        this.notify(() => this.lifecycle.ready(this.runtimeGeneration, client.port.channelId));
    }
    startupFailed(props, error) {
        let context;
        try {
            context = readContext(props?.containerContext);
        }
        catch {
            this.reportError(error);
            return;
        }
        if (this.ended || this.closed.has(context.channelId) || this.closing.has(context.channelId))
            return;
        this.reportError(error);
        if (context.runtimeGeneration !== this.runtimeGeneration)
            return;
        const owner = this.pages.get(context.channelId);
        // prepare 失败不证明它拥有该通道；不能把碰撞请求的错误转发给真实页面。
        if (owner && !this.matchesPage(owner, props, context))
            return;
        const root = this.rootCommits.get(context.channelId);
        if (root && !this.matchesRoot(root, props, context))
            return;
        const code = error instanceof URNError ? error.code : 'STARTUP_FAILED';
        const message = error instanceof Error ? error.message : '页面启动失败';
        this.notify(() => this.lifecycle.startupFailed(this.runtimeGeneration, context.channelId, code, message.slice(0, 256)));
        void this.close(context.channelId);
    }
    close(channelId) {
        const previous = this.closed.get(channelId) ?? this.closing.get(channelId);
        if (previous)
            return previous;
        if (!validIdentity(channelId))
            return Promise.resolve();
        const client = this.pages.get(channelId);
        if (!client && this.closed.size >= this.maxRetired)
            return this.ignoredClose;
        const closeStarted = performance.now();
        // close 先封闭业务入口，但保留 Port 供 Core 自己发送取消、退订和关闭控制。
        const cleanup = client?.close() ?? Promise.resolve();
        const task = cleanup.then(() => {
            this.dispatcher.retire(channelId);
            this.pages.delete(channelId);
            this.closing.delete(channelId);
            this.diagnostic('client.closed', channelId, performance.now() - closeStarted);
            this.pageStarted.delete(channelId);
            if (!this.ended)
                this.notify(() => this.lifecycle.disposed(this.runtimeGeneration, channelId));
        });
        this.closing.set(channelId, task);
        this.diagnostic('client.closing', channelId);
        if (this.closed.size < this.maxRetired)
            this.closed.set(channelId, task);
        // 未挂载页面也立即退役；不能等 Root 再来决定是否重开。
        if (!client)
            this.dispatcher.retire(channelId);
        return task;
    }
    notify(callback) {
        try {
            callback();
        }
        catch (error) {
            this.reportError(error);
        }
    }
    end() {
        if (this.ending)
            return this.ending;
        this.ended = true;
        this.closeSubscription.remove();
        this.pageSubscription?.remove();
        this.ending = Promise.all([...this.pages.keys()].map((id) => this.close(id))).then(() => {
            this.dispatcher.close();
            this.closed.clear();
            this.rootCommits.clear();
            this.pageStarted.clear();
            this.observers.clear();
        });
        return this.ending;
    }
}
const runtimeKey = Symbol.for('leo-urn.runtime-store.v1');
/** Symbol 与 globalThis 跨模块替换稳定，旧代 Store 立即停止接纳新业务。 */
export function getPageCoordinator(generation, channel, lifecycle, configuration, host = globalThis, budget) {
    const existing = host[runtimeKey];
    if (existing?.runtimeGeneration === generation) {
        existing.update(configuration, budget);
        return existing;
    }
    if (existing)
        void existing.end();
    const store = new PageCoordinator(generation, channel, lifecycle, configuration, budget);
    host[runtimeKey] = store;
    return store;
}
function lifecycleCommandAvailable(port) {
    return typeof port.command === 'function';
}
