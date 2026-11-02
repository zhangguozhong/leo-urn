import { useSyncExternalStore, type ReactNode } from 'react';
import * as Native from 'react-native';
import type { DiagnosticStore } from './Diagnostic.js';
/** 宿主显式传development才挂载；报告留在本地，导出去向由宿主决定。 */
interface PanelProps {
  readonly store: DiagnosticStore;
  readonly development?: boolean;
  readonly onExport?: (report: string) => void;
}
export function DiagnosticPanel(props: PanelProps): ReactNode {
  return props.development ? <DiagnosticPanelContent {...props} /> : null;
}
function DiagnosticPanelContent({ store, onExport }: PanelProps): ReactNode {
  const events = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return (
    <Native.View accessibilityLabel="URN diagnostics" style={{ maxHeight: 320, padding: 12 }}>
      <Native.Text>URN · {events.length} events</Native.Text>
      {onExport && (
        <Native.Pressable accessibilityRole="button" onPress={() => onExport(store.exportReport())}>
          <Native.Text>导出诊断报告</Native.Text>
        </Native.Pressable>
      )}
      <Native.ScrollView>
        {events.map((event, index) => (
          <Native.Text key={`${index}-${event.timestampMs}`}>
            {event.stage} {event.code ?? ''}{' '}
            {event.durationMs === undefined ? '' : `${Math.round(event.durationMs)}ms`}
          </Native.Text>
        ))}
      </Native.ScrollView>
    </Native.View>
  );
}
