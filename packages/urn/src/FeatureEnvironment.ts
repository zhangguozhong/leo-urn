import type { PageLifecycle, PageNavigation } from './PageExperience.js';
import type { ClientCore } from 'aeris-client-core/ClientCore';

/** 业务只能使用所属页面的调用/订阅能力；页面销毁由容器负责。 */
export type BusinessBridge = Pick<ClientCore, 'call' | 'subscribe'>;

export interface FeatureEnvironment {
  readonly pageId: string;
  readonly featureId: string;
  readonly bridge: BusinessBridge;
  readonly lifecycle: PageLifecycle;
  readonly navigation: PageNavigation;
}
