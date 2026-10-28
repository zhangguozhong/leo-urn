import type { ReactNode } from 'react';
import type { ContainerProps } from './PageCoordinator.js';
import { PageCoordinator } from './PageCoordinator.js';
/** RN 根视图很薄，Store 才拥有跨 FastRefresh 与 effect 重跑的页面资源。 */
export declare function ContainerRoot(props: ContainerProps & {
    readonly store: PageCoordinator;
}): ReactNode;
