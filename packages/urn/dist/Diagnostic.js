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
