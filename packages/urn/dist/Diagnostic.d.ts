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
/** 只复制诊断白名单，业务参数、错误消息和凭据不进入报告。 */
export declare class DiagnosticStore {
    private readonly capacity;
    private events;
    private listeners;
    constructor(capacity?: number);
    get snapshot(): readonly URNDiagnostic[];
    readonly getSnapshot: () => readonly URNDiagnostic[];
    readonly subscribe: (listener: () => void) => (() => void);
    record(event: URNDiagnostic): void;
    exportReport(): string;
}
