import type { CodegenTypes, TurboModule } from 'react-native';
export interface Spec extends TurboModule {
    command(generation: string, channel: string, command: string, id: string, payload: string): void;
    readonly onPageEvent: CodegenTypes.EventEmitter<Readonly<{
        runtimeGeneration: string;
        channelId: string;
        deliveryId: string;
        message: string;
    }>>;
    boot(generation: string): void;
    mounted(generation: string, channel: string): void;
    bridgeReady(generation: string, channel: string): void;
    ready(generation: string, channel: string): void;
    startupFailed(generation: string, channel: string, code: string, message: string): void;
    disposed(generation: string, channel: string): void;
    readonly onCloseRequested: CodegenTypes.EventEmitter<Readonly<{
        runtimeGeneration: string;
        channelId: string;
        deliveryId: string;
        reason: string;
    }>>;
}
declare const _default: Spec;
export default _default;
