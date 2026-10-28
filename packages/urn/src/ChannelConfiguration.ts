import { channelBudgetDefaults } from './ChannelBudgetDefaults.js';
import { URNError } from './URNError.js';

export type RuntimeBudget = Readonly<{
  [K in Exclude<keyof typeof channelBudgetDefaults, 'legacyJsMaxChannels'>]: number;
}>;

/** 原生只注入数值配置；复制后冻结，不保留全局对象或调用方引用。 */
export function readRuntimeBudget(value: unknown): RuntimeBudget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new URNError('INVALID_BUDGET', '运行时预算必须是对象');
  }
  const input = value as Record<string, unknown>;
  const budget: Record<string, number> = {};
  for (const key of Object.keys(channelBudgetDefaults)) {
    if (key === 'legacyJsMaxChannels') continue;
    const item = input[key];
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1) {
      throw new URNError('INVALID_BUDGET', '运行时预算必须是正安全整数');
    }
    budget[key] = item;
  }
  if (
    budget.maxChannels > 64 ||
    budget.maxRetiredChannels > 65536 ||
    budget.maxFrameBytes > 16 * 1024 * 1024 ||
    budget.jsPageMessages > 65536 ||
    budget.nativeMessages > 65536 ||
    budget.nativePageMessages > 65536 ||
    budget.jsPageBytes > 64 * 1024 * 1024 ||
    budget.nativePageBytes > 64 * 1024 * 1024 ||
    budget.nativeBytes > 256 * 1024 * 1024 ||
    budget.jsPageBytes < budget.maxFrameBytes ||
    budget.nativePageBytes < budget.maxFrameBytes ||
    budget.nativeBytes < budget.nativePageBytes ||
    budget.nativeMessages < budget.nativePageMessages ||
    budget.nativeOutboundWindow > 64 ||
    budget.nativeOutboundGlobalWindow > 512 ||
    budget.nativeOutboundGlobalWindow < budget.maxChannels ||
    budget.nativeBatchSize > 512 ||
    budget.nativeBatchSize > budget.nativeMessages
  )
    throw new URNError('INVALID_BUDGET', '预算超过安全上限或单帧/单页/总量关系不一致');
  return Object.freeze(budget) as RuntimeBudget;
}
