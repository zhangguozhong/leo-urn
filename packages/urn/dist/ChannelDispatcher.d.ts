import { ChannelPort, type ChannelBudget } from './ChannelPort.js';
import { type URNDiagnostic } from './Diagnostic.js';
export interface ChannelMessage {
    readonly runtimeGeneration: string;
    readonly channelId: string;
    readonly message: string;
    readonly deliveryId?: string;
}
export interface ChannelDisconnect {
    readonly runtimeGeneration: string;
    readonly code: string;
    readonly message: string;
}
export interface Removable {
    remove(): void;
}
export interface PhysicalChannel {
    acknowledge?(generation: string, channel: string, deliveryId: string): void;
    send(runtimeGeneration: string, channelId: string, message: string): void;
    onMessage(listener: (event: ChannelMessage) => void): Removable;
    onDisconnect(listener: (event: ChannelDisconnect) => void): Removable;
}
export interface DispatcherOptions extends Partial<ChannelBudget> {
    readonly maxChannels?: number;
    readonly maxRetiredChannels?: number;
    readonly onError?: (error: unknown) => void;
    readonly onDiagnostic?: (event: URNDiagnostic) => void;
}
export declare function validIdentity(value: unknown): value is string;
/** 一个 runtime 只有此处订阅物理消息；N=1 和 N>1 使用相同通道表。 */
export declare class ChannelDispatcher {
    readonly runtimeGeneration: string;
    private readonly native;
    private readonly options;
    private readonly ports;
    private readonly retired;
    private readonly subscriptions;
    private readonly budget;
    private readonly maxChannels;
    private readonly maxRetired;
    private stopped;
    constructor(runtimeGeneration: string, native: PhysicalChannel, options?: DispatcherOptions);
    /** 只确认当前物理运行轮次；未知或已退役页面同样归还信用。 */
    acknowledge(event: {
        runtimeGeneration: string;
        channelId: string;
        deliveryId?: string;
    }): void;
    open(channelId: string): ChannelPort;
    retire(channelId: string): void;
    snapshot(): Readonly<{
        channels: number;
        retired: number;
        queuedMessages: number;
        queuedBytes: number;
    }>;
    private disconnect;
    close(): void;
}
