import { utf8Size } from 'aeris-client-core/protocol';
import { URNError } from './URNError.js';
/** 每页一个虚拟端点。业务帧只计量和转交，不解码、不维护业务回调表。 */
export class ChannelPort {
    channelId;
    transmit;
    retire;
    budget;
    report;
    diagnostic;
    listener;
    closeListeners = new Set();
    queue = [];
    queuedBytes = 0;
    scheduled = false;
    failure;
    sentMessages = 0;
    sentBytes = 0;
    sendScheduled = false;
    constructor(channelId, transmit, retire, budget, report, diagnostic = () => { }) {
        this.channelId = channelId;
        this.transmit = transmit;
        this.retire = retire;
        this.budget = budget;
        this.report = report;
        this.diagnostic = diagnostic;
    }
    send(message) {
        if (this.failure)
            throw new URNError('DISCONNECTED', '页面通道已关闭');
        const bytes = typeof message === 'string' ? utf8Size(message) : Infinity;
        if (bytes > this.budget.maxFrameBytes ||
            ++this.sentMessages > this.budget.maxQueuedMessages ||
            (this.sentBytes += bytes) > this.budget.maxQueuedBytes) {
            this.close({ code: 'BACKPRESSURE', message: '页面发送预算耗尽' });
            throw new URNError('BACKPRESSURE', '页面发送预算耗尽');
        }
        if (!this.sendScheduled) {
            this.sendScheduled = true;
            queueMicrotask(() => {
                this.sentMessages = 0;
                this.sentBytes = 0;
                this.sendScheduled = false;
            });
        }
        try {
            this.transmit(message);
        }
        catch (error) {
            this.close({ code: 'DISCONNECTED', message: '原生通道发送失败' });
            throw error;
        }
    }
    onMessage(listener) {
        if (this.listener)
            throw new URNError('CHANNEL_OWNED', '虚拟端点已有接收器');
        this.listener = listener;
        if (this.failure)
            this.deliverClose();
        else
            this.schedule();
        return {
            remove: () => {
                if (this.listener === listener)
                    this.listener = undefined;
            },
        };
    }
    onClose(listener) {
        if (this.failure)
            this.safely(() => listener(this.failureValue()));
        else
            this.closeListeners.add(listener);
        return { remove: () => this.closeListeners.delete(listener) };
    }
    receive(message, consumed = () => { }) {
        if (this.failure) {
            consumed();
            return;
        }
        const bytes = typeof message === 'string' ? utf8Size(message) : Infinity;
        if (bytes > this.budget.maxFrameBytes ||
            this.queue.length >= this.budget.maxQueuedMessages ||
            this.queuedBytes + bytes > this.budget.maxQueuedBytes) {
            this.close({ code: 'BACKPRESSURE', message: '页面接收预算耗尽' });
            consumed();
            return;
        }
        this.queue.push({ message, consumed });
        this.queuedBytes += bytes;
        this.schedule();
    }
    schedule() {
        if (this.scheduled || !this.listener || !this.queue.length || this.failure)
            return;
        this.scheduled = true;
        queueMicrotask(() => {
            this.scheduled = false;
            // 本轮快照有界；重入新帧进入下一轮，无法扩张正在交付的批次。
            const batch = this.queue;
            this.queue = [];
            this.queuedBytes = 0;
            for (const frame of batch) {
                try {
                    const listener = this.listener;
                    if (!this.failure && listener)
                        this.safely(() => listener(frame.message));
                }
                finally {
                    frame.consumed();
                }
            }
        });
    }
    safely(callback) {
        try {
            callback();
        }
        catch (error) {
            try {
                this.report(error);
            }
            catch {
                // 诊断回调不能打断兄弟页面或关闭流程。
            }
        }
    }
    failureValue() {
        return this.failure ?? { code: 'DISCONNECTED', message: '页面通道已关闭' };
    }
    snapshot() {
        return Object.freeze({ queuedMessages: this.queue.length, queuedBytes: this.queuedBytes });
    }
    deliverClose() {
        const error = this.failureValue();
        const text = JSON.stringify({
            method: 'bridge.close',
            params: { code: error.code, reason: error.message.slice(0, 256) || 'Channel closed' },
        });
        const listener = this.listener;
        if (listener)
            this.safely(() => listener(text));
    }
    close(error = { code: 'DISCONNECTED', message: '页面通道已关闭' }) {
        if (this.failure)
            return;
        const snapshot = this.snapshot();
        this.failure = error;
        const discarded = this.queue;
        this.queue = [];
        for (const frame of discarded)
            frame.consumed();
        this.queuedBytes = 0;
        this.retire();
        // 独立控制槽不消耗业务消息配额，Core 仍使用其原有关闭协议。
        this.deliverClose();
        for (const listener of this.closeListeners)
            this.safely(() => listener(error));
        this.closeListeners.clear();
        this.diagnostic(error.code, snapshot);
    }
}
