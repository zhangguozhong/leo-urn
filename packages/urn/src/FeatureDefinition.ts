import type { ComponentType, ReactElement } from 'react';
import type { FeatureEnvironment } from './FeatureEnvironment.js';

export interface FeatureProps<P> {
  readonly params: P;
  readonly environment: FeatureEnvironment;
}

/** 本地目录与独立仓库业务包均只导出此契约，不注册 AppRegistry。 */
export interface FeatureModule {
  readonly version: string;
  readonly requiredCapabilities?: readonly string[];
  readonly paramsContract?: string;
  readonly baselineId?: string;
}
export interface FeaturePreflight {
  readonly capabilities?: readonly string[];
  readonly baselineId?: string;
}
export interface FeatureDefinition<P> {
  readonly module?: FeatureModule;
  readonly id: string;
  readonly component: ComponentType<FeatureProps<P>>;
  readonly parseParams: (raw: Record<string, unknown>) => P;
}

export interface ResolvedFeature {
  readonly id: string;
  readonly params: unknown;
  readonly module?: FeatureModule;
  render(environment: FeatureEnvironment): ReactElement;
}
