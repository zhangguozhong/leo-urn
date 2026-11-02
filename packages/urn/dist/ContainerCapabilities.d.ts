export type RouteTarget = {
    readonly kind: 'rn';
    readonly featureId: string;
} | {
    readonly kind: 'native' | 'flutter';
    readonly route: string;
} | {
    readonly kind: 'web';
    readonly url: string;
};
export interface RouteDefinition {
    readonly path: string;
    readonly target: RouteTarget;
}
/** dispatcher必须立即返回取消操作；UI所有权由result中的owner显式转移。 */
export interface RouteOwner {
    readonly id: string;
    close(): Promise<void>;
    capture?(): Promise<unknown>;
    restore?(state: unknown): Promise<void>;
}
export interface RouteOperation {
    readonly result: Promise<RouteOwner>;
    cancel(): Promise<void>;
}
export interface RouteContext {
    readonly source?: string;
    readonly signal: AbortSignal;
    readonly userDomain: string;
}
export interface ContainerCapabilitiesOptions {
    readonly baselineId: string;
    readonly routes: readonly RouteDefinition[];
    readonly dispatch: (target: RouteTarget, params: Readonly<Record<string, unknown>>, context: RouteContext) => RouteOperation;
    readonly moduleIdentity?: (target: RouteTarget) => unknown;
    readonly guard?: (target: RouteTarget, context: RouteContext) => boolean | Promise<boolean>;
    readonly fallback?: (target: RouteTarget, error: unknown, context: RouteContext) => RouteTarget | undefined | Promise<RouteTarget | undefined>;
    readonly maxQueued?: number;
    readonly timeoutMs?: number;
    readonly failureLimit?: number;
    readonly failureWindowMs?: number;
    readonly cooldownMs?: number;
    readonly maxSnapshotPages?: number;
    readonly maxSnapshotBytes?: number;
}
export interface ContainerSnapshot {
    readonly version: 1;
    readonly baselineId: string;
    readonly userDomain: string;
    readonly pages: readonly {
        readonly route: string;
        readonly params: Record<string, unknown>;
        readonly state: unknown;
        readonly compatibility?: unknown;
    }[];
}
/** Coordinator持有；每个异步请求都绑定页面epoch与用户域，关闭不转移清理责任。 */
export declare class ContainerCapabilities {
    private readonly options;
    private ready;
    private epoch;
    private readonly sourceEpoch;
    private domain;
    private entries;
    private cancelling;
    private cleanupTasks;
    private routes;
    private cleanup;
    private nextCleanupOwner;
    private readonly ownerBindings;
    private cleanupSources;
    private failures;
    private restoration?;
    private restorationState?;
    constructor(options: ContainerCapabilitiesOptions);
    get userDomain(): string;
    get pendingCleanupCount(): number;
    setReady(ready: boolean): void;
    private validateTarget;
    open(url: string, options?: {
        source?: string;
        params?: Record<string, unknown>;
        signal?: AbortSignal;
    }): RouteOperation;
    private valid;
    private settle;
    private start;
    private dispatchOperation;
    private cancel;
    private release;
    retryCleanup(source?: string): Promise<void>;
    invalidate(source?: string): Promise<void>;
    setUserDomain(domain: string): Promise<void>;
    resetCircuit(target?: RouteTarget): void;
    capture(pages: readonly {
        route: string;
        params: Record<string, unknown>;
        owner: RouteOwner;
    }[]): Promise<ContainerSnapshot>;
    private bindOwner;
    /** 外部owner由可信宿主显式证明创建域和路由；不能依赖capture时的当前用户自动补标。 */
    registerRestorationOwner(owner: RouteOwner, registration: {
        userDomain: string;
        route: string;
    }): void;
    private compatibilityForTarget;
    private compatibility;
    restore(read: () => Promise<unknown>, options?: {
        source?: string;
    }): Promise<readonly RouteOwner[]>;
    private restoreTransaction;
}
