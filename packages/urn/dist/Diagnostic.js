/** 观察器在当前状态转换退出后运行；不把观察器异常再次送回诊断系统。 */
export function publishDiagnostic(observer, data) {
    if (!observer)
        return;
    const event = Object.freeze({ ...data, timestampMs: Date.now() });
    queueMicrotask(() => {
        try {
            observer(event);
        }
        catch {
            /* 诊断系统不拥有业务生命周期。 */
        }
    });
}
/** 只复制诊断白名单，业务参数、错误消息和凭据不进入报告。 */
export class DiagnosticStore {
    capacity;
    events = Object.freeze([]);
    listeners = new Set();
    constructor(capacity = 128) {
        this.capacity = capacity;
        if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1024)
            throw Error('诊断预算须在1至1024');
    }
    get snapshot() {
        return this.events;
    }
    getSnapshot = () => this.events;
    subscribe = (listener) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };
    record(event) {
        const safe = {};
        for (const key of [
            'timestampMs',
            'stage',
            'runtimeGeneration',
            'pageId',
            'channelId',
            'durationMs',
            'code',
            'queuedMessages',
            'queuedBytes',
        ]) {
            const value = event[key];
            if (typeof value === 'number' && Number.isFinite(value))
                safe[key] = value;
            if (typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(value))
                safe[key] = value;
        }
        this.events = Object.freeze([
            ...this.events.slice(-(this.capacity - 1)),
            Object.freeze(safe),
        ].slice(-this.capacity));
        for (const listener of [...this.listeners]) {
            try {
                listener();
            }
            catch {
                /* 观察器不拥有容器。 */
            }
        }
    }
    exportReport() {
        return JSON.stringify({ version: 1, events: this.events });
    }
}
