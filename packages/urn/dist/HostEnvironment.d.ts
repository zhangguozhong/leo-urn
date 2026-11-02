export interface HostEnvironmentSnapshot {
    readonly revision: number;
    readonly theme: 'light' | 'dark' | 'system';
    readonly locale: string;
    readonly fontScale: number;
    readonly window: {
        readonly width: number;
        readonly height: number;
    };
    /** 非敏感的隔离标识；不要传入登录凭据。 */
    readonly userDomain: string;
}
export interface HostEnvironment {
    readonly snapshot: HostEnvironmentSnapshot;
    subscribe(listener: (snapshot: HostEnvironmentSnapshot) => void): () => void;
}
export declare class HostEnvironmentStore implements HostEnvironment {
    private readonly onError;
    private value;
    private listeners;
    private ended;
    constructor(onError?: (error: unknown) => void);
    get snapshot(): HostEnvironmentSnapshot;
    subscribe(listener: (snapshot: HostEnvironmentSnapshot) => void): () => void;
    private notify;
    update(raw: unknown): boolean;
    close(): void;
}
