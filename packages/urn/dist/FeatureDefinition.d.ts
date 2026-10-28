import type { ComponentType, ReactElement } from 'react';
import type { FeatureEnvironment } from './FeatureEnvironment.js';
export interface FeatureProps<P> {
    readonly params: P;
    readonly environment: FeatureEnvironment;
}
/** 本地目录与独立仓库业务包均只导出此契约，不注册 AppRegistry。 */
export interface FeatureDefinition<P> {
    readonly id: string;
    readonly component: ComponentType<FeatureProps<P>>;
    readonly parseParams: (raw: Record<string, unknown>) => P;
}
export interface ResolvedFeature {
    readonly id: string;
    readonly params: unknown;
    render(environment: FeatureEnvironment): ReactElement;
}
