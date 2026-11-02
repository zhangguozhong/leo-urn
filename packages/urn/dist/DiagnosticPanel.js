import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useSyncExternalStore } from 'react';
import * as Native from 'react-native';
export function DiagnosticPanel(props) {
    return props.development ? _jsx(DiagnosticPanelContent, { ...props }) : null;
}
function DiagnosticPanelContent({ store, onExport }) {
    const events = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    return (_jsxs(Native.View, { accessibilityLabel: "URN diagnostics", style: { maxHeight: 320, padding: 12 }, children: [_jsxs(Native.Text, { children: ["URN \u00B7 ", events.length, " events"] }), onExport && (_jsx(Native.Pressable, { accessibilityRole: "button", onPress: () => onExport(store.exportReport()), children: _jsx(Native.Text, { children: "\u5BFC\u51FA\u8BCA\u65AD\u62A5\u544A" }) })), _jsx(Native.ScrollView, { children: events.map((event, index) => (_jsxs(Native.Text, { children: [event.stage, " ", event.code ?? '', ' ', event.durationMs === undefined ? '' : `${Math.round(event.durationMs)}ms`] }, `${index}-${event.timestampMs}`))) })] }));
}
