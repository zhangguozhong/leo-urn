import { createElement } from 'react';
import { assertJSON } from 'aeris-client-core/protocol';
import { URNError } from './URNError.js';
const wrappedComponents = new Set([
    Symbol.for('react.memo'),
    Symbol.for('react.forward_ref'),
    Symbol.for('react.lazy'),
]);
function isComponent(value) {
    return (typeof value === 'function' ||
        (typeof value === 'object' &&
            value !== null &&
            '$$typeof' in value &&
            typeof value.$$typeof === 'symbol' &&
            wrappedComponents.has(value.$$typeof)));
}
export class FeatureRegistry {
    modules = new Map();
    entries = new Map();
    manifest(id) {
        return this.modules.get(id);
    }
    get size() {
        return this.entries.size;
    }
    register(definition) {
        if (!definition ||
            typeof definition.id !== 'string' ||
            definition.id.length > 128 ||
            !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(definition.id) ||
            typeof definition.parseParams !== 'function' ||
            !isComponent(definition.component)) {
            throw new URNError('INVALID_FEATURE', '业务需要合法 id、component 和 parseParams');
        }
        if (this.entries.has(definition.id)) {
            throw new URNError('DUPLICATE_FEATURE', `业务入口重复：${definition.id}`);
        }
        if (definition.module) {
            const metadata = definition.module;
            const capabilities = metadata.requiredCapabilities ?? [];
            if (!Array.isArray(capabilities) ||
                !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(metadata.version) ||
                capabilities.some((value) => typeof value !== 'string' || !/^[a-z][a-z0-9._-]{0,79}$/.test(value)) ||
                new Set(capabilities).size !== capabilities.length ||
                [metadata.paramsContract, metadata.baselineId].some((value) => value !== undefined && (typeof value !== 'string' || !value || value.length > 128)))
                throw new URNError('INVALID_MODULE', '模块版本、能力或契约声明不合法');
            this.modules.set(definition.id, Object.freeze({ ...metadata, requiredCapabilities: Object.freeze([...capabilities]) }));
        }
        // 解析器与组件通过闭包保持同一个 P，注册表无需将参数擦成 any。
        const { id, component, parseParams } = definition;
        this.entries.set(id, (raw) => {
            const params = parseParams(raw);
            return {
                id,
                params,
                module: this.modules.get(id),
                render: (environment) => createElement(component, { params, environment }),
            };
        });
        return this;
    }
    resolve(id, raw, host = {}) {
        const resolve = this.entries.get(id);
        if (!resolve)
            throw new URNError('FEATURE_NOT_FOUND', `未注册业务入口：${id}`);
        const metadata = this.modules.get(id);
        if (metadata?.baselineId && metadata.baselineId !== host.baselineId)
            throw new URNError('BASELINE_MISMATCH', '模块要求不同基线');
        if (metadata?.requiredCapabilities?.some((value) => !host.capabilities?.includes(value)))
            throw new URNError('CAPABILITY_MISSING', '宿主缺少模块要求的能力');
        try {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                throw new Error('参数必须为 JSON 对象');
            }
            assertJSON(raw);
            return resolve(raw);
        }
        catch {
            throw new URNError('INVALID_PARAMS', `业务参数不符合 ${id} 的 parseParams 契约`);
        }
    }
}
