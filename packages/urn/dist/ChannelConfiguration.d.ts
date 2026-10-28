import { channelBudgetDefaults } from './ChannelBudgetDefaults.js';
export type RuntimeBudget = Readonly<{
    [K in Exclude<keyof typeof channelBudgetDefaults, 'legacyJsMaxChannels'>]: number;
}>;
/** 原生只注入数值配置；复制后冻结，不保留全局对象或调用方引用。 */
export declare function readRuntimeBudget(value: unknown): RuntimeBudget;
