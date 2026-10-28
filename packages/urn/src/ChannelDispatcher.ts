import type { BridgeError } from 'aeris-client-core/protocol';
import { ChannelPort, type ChannelBudget } from './ChannelPort.js';
import { URNError } from './URNError.js';
import { channelBudgetDefaults } from './ChannelBudgetDefaults.js';
import { publishDiagnostic, type URNDiagnostic } from './Diagnostic.js';

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

export function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

/** 一个 runtime 只有此处订阅物理消息；N=1 和 N>1 使用相同通道表。 */
export class ChannelDispatcher {
  private readonly ports = new Map<string, ChannelPort>();
  private readonly retired = new Set<string>();
  private readonly subscriptions: Removable[] = [];
  private readonly budget: ChannelBudget;
  private readonly maxChannels: number;
  private readonly maxRetired: number;
  private stopped = false;

  constructor(
    readonly runtimeGeneration: string,
    private readonly native: PhysicalChannel,
    private readonly options: DispatcherOptions = {},
  ) {
    if (!validIdentity(runtimeGeneration)) throw new URNError('INVALID_GENERATION', '缺少原生轮次');
    this.budget = {
      maxQueuedMessages: options.maxQueuedMessages ?? channelBudgetDefaults.jsPageMessages,
      maxQueuedBytes: options.maxQueuedBytes ?? channelBudgetDefaults.jsPageBytes,
      maxFrameBytes: options.maxFrameBytes ?? channelBudgetDefaults.maxFrameBytes,
    };
    this.maxChannels = options.maxChannels ?? channelBudgetDefaults.legacyJsMaxChannels;
    this.maxRetired = options.maxRetiredChannels ?? channelBudgetDefaults.maxRetiredChannels;
    for (const value of [...Object.values(this.budget), this.maxChannels, this.maxRetired]) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new URNError('INVALID_BUDGET', '通道预算必须是正整数');
      }
    }
    try {
      this.subscriptions.push(
        native.onMessage((event) => {
          if (this.stopped || event.runtimeGeneration !== this.runtimeGeneration) return;
          const acknowledge = () => this.acknowledge(event);
          const port = this.ports.get(event.channelId);
          if (!port) acknowledge();
          else port.receive(event.message, acknowledge);
        }),
      );
      this.subscriptions.push(
        native.onDisconnect((event) => {
          if (event.runtimeGeneration !== this.runtimeGeneration) return;
          this.disconnect({ code: 'DISCONNECTED', message: event.message });
        }),
      );
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** 只确认当前物理运行轮次；未知或已退役页面同样归还信用。 */
  acknowledge(event: { runtimeGeneration: string; channelId: string; deliveryId?: string }): void {
    if (event.runtimeGeneration !== this.runtimeGeneration || !validIdentity(event.deliveryId))
      return;
    try {
      this.native.acknowledge?.(event.runtimeGeneration, event.channelId, event.deliveryId);
    } catch (error) {
      try {
        this.options.onError?.(error);
      } catch {
        /* 诊断异常不影响其他页面。 */
      }
    }
  }

  open(channelId: string): ChannelPort {
    if (!validIdentity(channelId)) throw new URNError('INVALID_CHANNEL', '缺少页面通道标识');
    if (this.stopped) throw new URNError('DISCONNECTED', '运行时通道已关闭');
    if (this.retired.has(channelId)) throw new URNError('CHANNEL_RETIRED', '页面通道不能重新使用');
    if (this.ports.has(channelId)) throw new URNError('CHANNEL_OWNED', '页面通道已被占用');
    // 达到退役上限后停止接纳新页面，避免淘汰墓碑后旧页面复活。
    if (this.retired.size >= this.maxRetired) {
      throw new URNError('RETIREMENT_CAPACITY', '当前轮次页面退役记录已满');
    }
    if (this.ports.size >= this.maxChannels) throw new URNError('CHANNEL_CAPACITY', '页面通道已满');
    const port = new ChannelPort(
      channelId,
      (message) => this.native.send(this.runtimeGeneration, channelId, message),
      () => this.retire(channelId),
      this.budget,
      (error) => this.options.onError?.(error),
      (code, snapshot) =>
        publishDiagnostic(this.options.onDiagnostic, {
          stage: code === 'BACKPRESSURE' ? 'channel.backpressure' : 'channel.closed',
          runtimeGeneration: this.runtimeGeneration,
          channelId,
          code: code === 'BACKPRESSURE' ? 'BACKPRESSURE' : 'DISCONNECTED',
          ...snapshot,
        }),
    );
    this.ports.set(channelId, port);
    return port;
  }

  retire(channelId: string): void {
    const port = this.ports.get(channelId);
    this.ports.delete(channelId);
    if (this.retired.size < this.maxRetired) this.retired.add(channelId);
    port?.close();
  }

  snapshot(): Readonly<{
    channels: number;
    retired: number;
    queuedMessages: number;
    queuedBytes: number;
  }> {
    const ports = [...this.ports.values()].map((port) => port.snapshot());
    return Object.freeze({
      channels: this.ports.size,
      retired: this.retired.size,
      queuedMessages: ports.reduce((sum, port) => sum + port.queuedMessages, 0),
      queuedBytes: ports.reduce((sum, port) => sum + port.queuedBytes, 0),
    });
  }

  private disconnect(error: BridgeError): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const port of [...this.ports.values()]) port.close(error);
  }

  close(): void {
    this.disconnect({ code: 'DISCONNECTED', message: '运行时已结束' });
    for (const subscription of this.subscriptions.splice(0)) subscription.remove();
  }
}
