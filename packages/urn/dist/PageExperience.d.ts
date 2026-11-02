import { HostEnvironmentStore } from './HostEnvironment.js';
import type { ContainerCapabilities, RouteOperation } from './ContainerCapabilities.js';
export interface PageLifecycleSnapshot {
    readonly visible: boolean;
    readonly foreground: boolean;
    readonly closed: boolean;
}
export interface PageLifecycle {
    readonly snapshot: PageLifecycleSnapshot;
    /** 立即回放当前快照；返回取消监听函数。隐藏和后台都不关闭页面连接。 */
    subscribe(listener: (state: PageLifecycleSnapshot) => void): () => void;
}
export type PageResult = {
    readonly status: 'completed';
    readonly data?: Record<string, unknown>;
} | {
    readonly status: 'cancelled';
};
export interface PageNavigation {
    /** 与原生App调用openRoute共用dispatcher、guard与生命周期。完成值表示目标真实就绪。 */
    openDeepLink(url: string, params?: Record<string, unknown>, options?: {
        readonly signal?: AbortSignal;
    }): Promise<PageResult>;
    openRoute?(url: string, options?: {
        params?: Record<string, unknown>;
        signal?: AbortSignal;
    }): RouteOperation;
    open(featureId: string, params?: Record<string, unknown>, options?: {
        readonly presentation?: 'push' | 'present';
    }): Promise<PageResult>;
    /** 完成导航移除后才向调用页返回；原生拒绝关闭通过 onError 报告。 */
    close(result?: Record<string, unknown>): void;
}
/** 每页独占：导航请求、结果和生命周期都不会共享到其他 Client。 */
export declare class PageExperience {
    private readonly command;
    private readonly onError;
    private readonly launchTimeout;
    private state;
    private seq;
    private nextId;
    private readonly listeners;
    private readonly pending;
    readonly hostEnvironment: HostEnvironmentStore;
    readonly lifecycle: PageLifecycle;
    readonly navigation: PageNavigation;
    constructor(command: (command: string, id: string, payload: string) => void, onError: (error: unknown) => void, launchTimeout?: number, routes?: {
        runtime: ContainerCapabilities;
        source: string;
    });
    private assertActive;
    private encode;
    private notify;
    private report;
    private reject;
    receive(value: unknown): void;
    close(): void;
}
