export interface URNDiagnostic {
    readonly timestampMs: number;
    readonly stage: string;
    readonly runtimeGeneration?: string;
    readonly pageId?: string;
    readonly channelId?: string;
    readonly featureId?: string;
    readonly durationMs?: number;
    readonly code?: string;
    readonly queuedMessages?: number;
    readonly queuedBytes?: number;
}
/** 观察器在当前状态转换退出后运行；不把观察器异常再次送回诊断系统。 */
export declare function publishDiagnostic(observer: ((event: URNDiagnostic) => void) | undefined, data: Omit<URNDiagnostic, 'timestampMs'>): void;
