import type { CodegenTypes, TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  acknowledge(generation: string, channel: string, deliveryId: string): void;
  send(runtimeGeneration: string, channelId: string, message: string): void;
  readonly onMessage: CodegenTypes.EventEmitter<
    Readonly<{ runtimeGeneration: string; channelId: string; deliveryId: string; message: string }>
  >;
  readonly onDisconnect: CodegenTypes.EventEmitter<
    Readonly<{ runtimeGeneration: string; code: string; message: string }>
  >;
}

export default TurboModuleRegistry.getEnforcing<Spec>('URNChannel');
