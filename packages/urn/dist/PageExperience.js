import { assertJSON, utf8Size } from 'aeris-client-core/protocol';
import { URNError } from './URNError.js';
function jsonObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Error('需要JSON对象');
    assertJSON(value);
}
/** 每页独占：导航请求、结果和生命周期都不会共享到其他 Client。 */
export class PageExperience {
    command;
    onError;
    launchTimeout;
    state = Object.freeze({
        visible: false,
        foreground: true,
        closed: false,
    });
    seq = 0;
    nextId = 0;
    listeners = new Set();
    pending = new Map();
    lifecycle;
    navigation;
    constructor(command, onError, launchTimeout = 15000) {
        this.command = command;
        this.onError = onError;
        this.launchTimeout = launchTimeout;
        const owner = this;
        this.lifecycle = Object.freeze({
            get snapshot() {
                return owner.state;
            },
            subscribe: (listener) => {
                if (!this.state.closed)
                    this.listeners.add(listener);
                this.notify(listener);
                return () => {
                    this.listeners.delete(listener);
                };
            },
        });
        this.navigation = Object.freeze({
            open: async (featureId, params = {}, options) => {
                this.assertActive();
                if (this.pending.size >= 16)
                    throw new URNError('NAVIGATION_LIMIT', '等待返回的页面数量达到上限');
                const payload = this.encode({
                    featureId,
                    params,
                    presentation: options?.presentation ?? 'push',
                });
                if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(featureId) ||
                    featureId.length > 80 ||
                    !['push', 'present'].includes(options?.presentation ?? 'push'))
                    throw new URNError('INVALID_NAVIGATION', '业务入口或呈现方式不合法');
                try {
                    jsonObject(params);
                }
                catch {
                    throw new URNError('INVALID_NAVIGATION', '导航参数必须是JSON对象');
                }
                const id = String(++this.nextId);
                return new Promise((resolve, reject) => {
                    const entry = { resolve, reject };
                    entry.timer = setTimeout(() => {
                        this.reject(id, new URNError('NAVIGATION_TIMEOUT', '原生未确认打开页面'));
                        try {
                            this.command('cancelOpen', id, '{}');
                        }
                        catch (error) {
                            this.report(error);
                        }
                    }, this.launchTimeout);
                    this.pending.set(id, entry);
                    try {
                        this.command('open', id, payload);
                    }
                    catch (error) {
                        this.reject(id, error);
                    }
                });
            },
            close: (result) => {
                this.assertActive();
                if (result !== undefined) {
                    try {
                        jsonObject(result);
                    }
                    catch {
                        throw new URNError('INVALID_NAVIGATION', '返回值须为JSON对象');
                    }
                }
                this.command('close', '', this.encode(result === undefined ? {} : { data: result }));
            },
        });
    }
    assertActive() {
        if (this.state.closed)
            throw new URNError('DISCONNECTED', '页面已关闭');
    }
    encode(value) {
        try {
            assertJSON(value);
            const text = JSON.stringify(value);
            if (utf8Size(text) > 16384)
                throw Error('导航参数过大');
            return text;
        }
        catch {
            throw new URNError('INVALID_NAVIGATION', '导航参数须为16KB以内的JSON');
        }
    }
    notify(listener) {
        try {
            listener(this.state);
        }
        catch (error) {
            this.report(error);
        }
    }
    report(error) {
        try {
            this.onError(error);
        }
        catch {
            /* 诊断异常不能中断其他页面。 */
        }
    }
    reject(id, error) {
        const entry = this.pending.get(id);
        if (!entry)
            return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(error);
    }
    receive(value) {
        if (this.state.closed)
            return;
        try {
            jsonObject(value);
            if (value.type === 'lifecycle') {
                if (!Number.isSafeInteger(value.seq) ||
                    typeof value.seq !== 'number' ||
                    value.seq <= 0 ||
                    typeof value.visible !== 'boolean' ||
                    typeof value.foreground !== 'boolean')
                    throw Error('生命周期快照不合法');
                if (value.seq <= this.seq)
                    return;
                this.seq = value.seq;
                this.state = Object.freeze({
                    visible: value.visible,
                    foreground: value.foreground,
                    closed: false,
                });
                for (const listener of [...this.listeners])
                    this.notify(listener);
                return;
            }
            if (typeof value.id !== 'string' ||
                !['opened', 'result', 'error'].includes(String(value.type)))
                throw Error('导航响应不合法');
            if (value.type === 'error' && value.id === '') {
                if (typeof value.code !== 'string')
                    throw Error('缺少错误码');
                this.report(new URNError(value.code, '原生拒绝关闭页面'));
                return;
            }
            const entry = this.pending.get(value.id);
            if (!entry)
                return;
            if (value.type === 'opened') {
                if (typeof value.pageId !== 'string' || !value.pageId)
                    throw Error('缺少目标页面');
                clearTimeout(entry.timer);
            }
            else if (value.type === 'error') {
                if (typeof value.code !== 'string')
                    throw Error('缺少错误码');
                this.reject(value.id, new URNError(value.code, '原生导航失败'));
            }
            else {
                jsonObject(value.result);
                const result = value.result;
                if (result.status !== 'completed' && result.status !== 'cancelled')
                    throw Error('返回状态不合法');
                if (result.data !== undefined)
                    jsonObject(result.data);
                clearTimeout(entry.timer);
                this.pending.delete(value.id);
                entry.resolve(result.status === 'completed'
                    ? { status: 'completed', ...(result.data === undefined ? {} : { data: result.data }) }
                    : { status: 'cancelled' });
            }
        }
        catch (error) {
            this.report(error);
        }
    }
    close() {
        if (this.state.closed)
            return;
        this.state = Object.freeze({ ...this.state, visible: false, closed: true });
        for (const listener of [...this.listeners])
            this.notify(listener);
        this.listeners.clear();
        for (const id of this.pending.keys())
            this.reject(id, new URNError('DISCONNECTED', '调用页面已关闭'));
    }
}
