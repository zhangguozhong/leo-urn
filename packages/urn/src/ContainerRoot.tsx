import {
  Component,
  Suspense,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import type { ContainerClient } from './ContainerClient.js';
import type { ContainerProps, PreparedPage } from './PageCoordinator.js';
import { PageCoordinator } from './PageCoordinator.js';

interface BoundaryProps {
  readonly children: ReactNode;
  readonly onError: (error: unknown) => void;
}
class BusinessBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.onError(error);
  }
  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function BusinessScreen({
  page,
  store,
}: {
  readonly page: PreparedPage;
  readonly store: PageCoordinator;
}): ReactNode {
  useLayoutEffect(() => {
    let committed = true;
    queueMicrotask(() => {
      if (committed) store.reportContentReady(page.client);
    });
    return () => {
      committed = false;
    };
  }, [store, page.client]);
  return page.feature.render(page.client.environment);
}

/** RN 根视图很薄，Store 才拥有跨 FastRefresh 与 effect 重跑的页面资源。 */
export function ContainerRoot(
  props: ContainerProps & { readonly store: PageCoordinator },
): ReactNode {
  const { store } = props;
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  let page: PreparedPage | undefined;
  let preparationError: unknown;
  try {
    page = store.prepare(props);
  } catch (error) {
    preparationError = error;
  }
  const client = page?.client;
  const [readyClient, setReadyClient] = useState<ContainerClient>();

  useEffect(() => {
    store.rootMounted(props);
  }, [store, props]);

  useEffect(() => {
    if (preparationError) store.startupFailed(props, preparationError);
  }, [preparationError, store, props]);

  useEffect(() => {
    if (!client) return;
    let observing = true;
    const close = client.port.onClose(() => {
      if (observing) setReadyClient(undefined);
    });
    void store.reportReady(client).then(
      () => {
        if (observing && client.active) setReadyClient(client);
      },
      (error: unknown) => {
        // Adapter 可能已先关闭；Store 通过所有权和关闭记录排除主动关闭。
        if (observing) store.startupFailed(props, error);
      },
    );
    return () => {
      observing = false;
      close.remove();
      // effect cleanup 可能来自 StrictMode 或 FastRefresh；原生关闭才拥有销毁权。
    };
  }, [client, store]);

  if (!page || client !== readyClient || !client?.active) return null;
  return (
    <BusinessBoundary
      key={client.port.channelId}
      onError={(error) => store.startupFailed(props, error)}
    >
      <Suspense fallback={null}>
        <BusinessScreen page={page} store={store} />
      </Suspense>
    </BusinessBoundary>
  );
}
