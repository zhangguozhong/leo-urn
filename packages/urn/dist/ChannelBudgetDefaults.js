// 由 config/channel-budget.json 生成，请修改来源后执行 generate-budget.mjs。
export const channelBudgetDefaults = Object.freeze({
    maxChannels: 64,
    legacyJsMaxChannels: 128,
    maxRetiredChannels: 4096,
    maxFrameBytes: 262144,
    jsPageMessages: 64,
    jsPageBytes: 524288,
    nativeMessages: 512,
    nativeBytes: 8388608,
    nativePageMessages: 64,
    nativePageBytes: 2097152,
    nativeBatchSize: 8,
    nativeOutboundWindow: 4,
    nativeOutboundGlobalWindow: 64,
});
