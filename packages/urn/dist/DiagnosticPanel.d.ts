import { type ReactNode } from 'react';
import type { DiagnosticStore } from './Diagnostic.js';
/** 宿主显式传development才挂载；报告留在本地，导出去向由宿主决定。 */
interface PanelProps {
    readonly store: DiagnosticStore;
    readonly development?: boolean;
    readonly onExport?: (report: string) => void;
}
export declare function DiagnosticPanel(props: PanelProps): ReactNode;
export {};
