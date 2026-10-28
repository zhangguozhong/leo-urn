import { type BridgeError } from 'aeris-client-core/protocol';
import type { NativePort } from 'aeris-react-native/RNAdapter';
export interface ChannelBudget {
    readonly maxQueuedMessages: number;
    readonly maxQueuedBytes: number;
    readonly maxFrameBytes: number;
}
/** 每页一个虚拟端点。业务帧只计量和转交，不解码、不维护业务回调表。 */
export declare class ChannelPort implements NativePort {
    readonly channelId: string;
    private readonly transmit;
    private readonly retire;
    private readonly budget;
    private readonly report;
    private readonly diagnostic;
    private listener?;
    private readonly closeListeners;
    private queue;
    private queuedBytes;
    private scheduled;
    private failure?;
    private sentMessages;
    private sentBytes;
    private sendScheduled;
    constructor(channelId: string, transmit: (message: string) => void, retire: () => void, budget: ChannelBudget, report: (error: unknown) => void, diagnostic?: (code: string, snapshot: {
        queuedMessages: number;
        queuedBytes: number;
    }) => void);
    send(message: string): void;
    onMessage(listener: (message: string) => void): {
        remove(): void;
    };
    onClose(listener: (error: BridgeError) => void): {
        remove(): void;
    };
    receive(message: string, consumed?: () => void): void;
    private schedule;
    private safely;
    private failureValue;
    snapshot(): Readonly<{
        queuedMessages: number;
        queuedBytes: number;
    }>;
    private deliverClose;
    close(error?: BridgeError): void;
}
