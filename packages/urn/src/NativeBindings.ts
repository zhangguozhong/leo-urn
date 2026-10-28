import { createElement } from 'react';
import { AppRegistry } from 'react-native';
import NativeChannel from './specs/NativeURNChannel.js';
import NativeLifecycle from './specs/NativeURNLifecycle.js';
import { validIdentity } from './ChannelDispatcher.js';
import { ContainerRoot } from './ContainerRoot.js';
import type { ContainerProps, RegistrationOptions } from './PageCoordinator.js';
import { getPageCoordinator } from './PageCoordinator.js';
import type { FeatureRegistry } from './FeatureRegistry.js';
import { URNError } from './URNError.js';
import { readRuntimeBudget } from './ChannelConfiguration.js';

/** 唯一原生注册入口。轮次由实际 RN runtime 初始化注入，JS 不生成替代值。 */
export function registerFeatures(registry: FeatureRegistry, options: RegistrationOptions): void {
  if (!validIdentity(options?.baselineId))
    throw new URNError('INVALID_BASELINE', '需要固定基线标识');
  const generation = (globalThis as { __URNGeneration?: unknown }).__URNGeneration;
  if (!validIdentity(generation)) throw new URNError('INVALID_GENERATION', '原生尚未注入运行轮次');
  const rawBudget = (globalThis as { __URNChannelBudget?: unknown }).__URNChannelBudget;
  const budget = rawBudget === undefined ? undefined : readRuntimeBudget(rawBudget);
  const store = getPageCoordinator(
    generation,
    NativeChannel,
    NativeLifecycle,
    {
      registry,
      baselineId: options.baselineId,
      onError: options.onError,
      onDiagnostic: options.onDiagnostic,
      includeFeatureIdsInDiagnostics: options.includeFeatureIdsInDiagnostics,
    },
    undefined,
    budget
      ? {
          maxChannels: budget.maxChannels,
          maxRetiredChannels: budget.maxRetiredChannels,
          maxFrameBytes: budget.maxFrameBytes,
          maxQueuedMessages: budget.jsPageMessages,
          maxQueuedBytes: budget.jsPageBytes,
        }
      : undefined,
  );
  AppRegistry.registerComponent('URNRoot', () => {
    return function URNRoot(props: ContainerProps) {
      return createElement(ContainerRoot, { ...props, store });
    };
  });
  // 等 bundle 顶层执行退出后确认启动，原生才能安全处理“打开后立即关闭”。
  setTimeout(() => NativeLifecycle.boot(generation), 0);
}
