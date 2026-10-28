import { ChannelDispatcher } from './ChannelDispatcher.js';
import type { DispatcherOptions, PhysicalChannel, Removable } from './ChannelDispatcher.js';
import { ContainerClient } from './ContainerClient.js';
import type { ResolvedFeature } from './FeatureDefinition.js';
import type { FeatureRegistry } from './FeatureRegistry.js';
import { type URNDiagnostic } from './Diagnostic.js';
export interface ContainerContext {
    readonly pageId: string;
    readonly channelId: string;
    readonly runtimeGeneration: string;
    readonly baselineId: string;
}
export interface ContainerProps {
    readonly featureId: string;
    readonly params: Record<string, unknown>;
    readonly containerContext: ContainerContext;
}
export interface CloseRequested {
    readonly runtimeGeneration: string;
    readonly channelId: string;
    readonly reason: string;
    readonly deliveryId?: string;
}
export interface LifecyclePort {
    mounted(generation: string, channel: string): void;
    bridgeReady?(generation: string, channel: string): void;
    ready(generation: string, channel: string): void;
    startupFailed(generation: string, channel: string, code: string, message: string): void;
    disposed(generation: string, channel: string): void;
    command?(generation: string, channel: string, command: string, id: string, payload: string): void;
    onPageEvent?(listener: (event: {
        runtimeGeneration: string;
        channelId: string;
        message: string;
        deliveryId?: string;
    }) => void): Removable;
    onCloseRequested(listener: (event: CloseRequested) => void): Removable;
}
export interface RegistrationOptions {
    readonly baselineId: string;
    readonly onError?: (error: unknown) => void;
    readonly onDiagnostic?: (event: URNDiagnostic) => void;
    readonly includeFeatureIdsInDiagnostics?: boolean;
}
export interface RuntimeConfiguration extends RegistrationOptions {
    readonly registry: FeatureRegistry;
}
export interface PreparedPage {
    readonly client: ContainerClient;
    readonly feature: ResolvedFeature;
}
export declare function readContext(value: unknown): ContainerContext;
/** 所有权属于原生页面；React effect cleanup 只撤销观察，不销毁 Client。 */
export declare class PageCoordinator {
    readonly runtimeGeneration: string;
    private readonly lifecycle;
    readonly dispatcher: ChannelDispatcher;
    private readonly pages;
    private readonly closed;
    private readonly closing;
    private readonly ignoredClose;
    private readonly rootCommits;
    private readonly maxRootCommits;
    private readonly readyPages;
    private readonly contentPages;
    private readonly maxRetired;
    private readonly closeSubscription;
    private readonly pageSubscription?;
    private ended;
    private ending?;
    private configuration;
    private revision;
    private readonly observers;
    private readonly budgetSignature;
    private readonly pageStarted;
    readonly getSnapshot: () => number;
    readonly subscribe: (observer: () => void) => (() => void);
    constructor(runtimeGeneration: string, channel: PhysicalChannel, lifecycle: LifecyclePort, configuration: RuntimeConfiguration, options?: DispatcherOptions);
    update(configuration: RuntimeConfiguration, budget?: DispatcherOptions): void;
    reportError(error: unknown): void;
    private diagnostic;
    prepare(props: ContainerProps): PreparedPage;
    private matchesPage;
    private owns;
    private matchesRoot;
    private notifyMounted;
    rootMounted(props: ContainerProps): void;
    mounted(client: ContainerClient): void;
    reportReady(client: ContainerClient): Promise<void>;
    /** 业务子树成功提交后调用；握手、Suspense 等待和失败都不能提前结束加载。 */
    reportContentReady(client: ContainerClient): void;
    startupFailed(props: ContainerProps, error: unknown): void;
    close(channelId: string): Promise<void>;
    private notify;
    end(): Promise<void>;
}
declare const runtimeKey: unique symbol;
type RuntimeHost = {
    [runtimeKey]?: PageCoordinator;
};
/** Symbol 与 globalThis 跨模块替换稳定，旧代 Store 立即停止接纳新业务。 */
export declare function getPageCoordinator(generation: string, channel: PhysicalChannel, lifecycle: LifecyclePort, configuration: RuntimeConfiguration, host?: RuntimeHost, budget?: DispatcherOptions): PageCoordinator;
export {};
