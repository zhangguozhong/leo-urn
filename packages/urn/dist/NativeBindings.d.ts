import type { RegistrationOptions } from './PageCoordinator.js';
import type { FeatureRegistry } from './FeatureRegistry.js';
/** 唯一原生注册入口。轮次由实际 RN runtime 初始化注入，JS 不生成替代值。 */
export declare function registerFeatures(registry: FeatureRegistry, options: RegistrationOptions): void;
