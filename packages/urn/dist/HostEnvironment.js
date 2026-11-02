import { URNError } from './URNError.js';
export class HostEnvironmentStore {
    onError;
    value = Object.freeze({
        revision: 0,
        theme: 'system',
        locale: 'und',
        fontScale: 1,
        window: Object.freeze({ width: 0, height: 0 }),
        userDomain: 'anonymous',
    });
    listeners = new Set();
    ended = false;
    constructor(onError = () => { }) {
        this.onError = onError;
    }
    get snapshot() {
        return this.value;
    }
    subscribe(listener) {
        if (!this.ended) {
            this.listeners.add(listener);
            this.notify(listener);
        }
        return () => {
            this.listeners.delete(listener);
        };
    }
    notify(listener) {
        try {
            listener(this.value);
        }
        catch (error) {
            try {
                this.onError(error);
            }
            catch {
                /* 环境监听隔离。 */
            }
        }
    }
    update(raw) {
        if (this.ended)
            return false;
        const value = raw;
        if (!value ||
            !Number.isSafeInteger(value.revision) ||
            value.revision < 0 ||
            !['system', 'light', 'dark'].includes(value.theme) ||
            typeof value.locale !== 'string' ||
            !/^[A-Za-z0-9_-]{1,80}$/.test(value.locale) ||
            !Number.isFinite(value.fontScale) ||
            value.fontScale <= 0 ||
            value.fontScale > 10 ||
            !value.window ||
            ![value.window.width, value.window.height].every((n) => Number.isFinite(n) && n >= 0 && n <= 100000) ||
            !/^[A-Za-z0-9._-]{1,128}$/.test(value.userDomain))
            throw new URNError('INVALID_ENVIRONMENT', '宿主环境快照非法');
        if (value.revision <= this.value.revision)
            return false;
        this.value = Object.freeze({
            revision: value.revision,
            theme: value.theme,
            locale: value.locale,
            fontScale: value.fontScale,
            userDomain: value.userDomain,
            window: Object.freeze({ width: value.window.width, height: value.window.height }),
        });
        for (const listener of [...this.listeners])
            this.notify(listener);
        return true;
    }
    close() {
        this.ended = true;
        this.listeners.clear();
    }
}
