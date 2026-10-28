import { jsx as _jsx } from "react/jsx-runtime";
import { Component, Suspense, useEffect, useLayoutEffect, useState, useSyncExternalStore, } from 'react';
class BusinessBoundary extends Component {
    state = { failed: false };
    static getDerivedStateFromError() {
        return { failed: true };
    }
    componentDidCatch(error, _info) {
        this.props.onError(error);
    }
    render() {
        return this.state.failed ? null : this.props.children;
    }
}
function BusinessScreen({ page, store, }) {
    useLayoutEffect(() => {
        let committed = true;
        queueMicrotask(() => {
            if (committed)
                store.reportContentReady(page.client);
        });
        return () => {
            committed = false;
        };
    }, [store, page.client]);
    return page.feature.render(page.client.environment);
}
/** RN 根视图很薄，Store 才拥有跨 FastRefresh 与 effect 重跑的页面资源。 */
export function ContainerRoot(props) {
    const { store } = props;
    useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    let page;
    let preparationError;
    try {
        page = store.prepare(props);
    }
    catch (error) {
        preparationError = error;
    }
    const client = page?.client;
    const [readyClient, setReadyClient] = useState();
    useEffect(() => {
        store.rootMounted(props);
    }, [store, props]);
    useEffect(() => {
        if (preparationError)
            store.startupFailed(props, preparationError);
    }, [preparationError, store, props]);
    useEffect(() => {
        if (!client)
            return;
        let observing = true;
        const close = client.port.onClose(() => {
            if (observing)
                setReadyClient(undefined);
        });
        void store.reportReady(client).then(() => {
            if (observing && client.active)
                setReadyClient(client);
        }, (error) => {
            // Adapter 可能已先关闭；Store 通过所有权和关闭记录排除主动关闭。
            if (observing)
                store.startupFailed(props, error);
        });
        return () => {
            observing = false;
            close.remove();
            // effect cleanup 可能来自 StrictMode 或 FastRefresh；原生关闭才拥有销毁权。
        };
    }, [client, store]);
    if (!page || client !== readyClient || !client?.active)
        return null;
    return (_jsx(BusinessBoundary, { onError: (error) => store.startupFailed(props, error), children: _jsx(Suspense, { fallback: null, children: _jsx(BusinessScreen, { page: page, store: store }) }) }, client.port.channelId));
}
