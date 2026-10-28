import Foundation

extension URNChannelBudget {
    func validate() throws {
        guard values.values.allSatisfy({ $0 > 0 }), maxChannels <= 64, maxRetiredChannels <= 65536,
            maxFrameBytes <= 16 * 1024 * 1024, jsPageMessages <= 65536, nativeMessages <= 65536,
            nativePageMessages <= 65536, jsPageBytes <= 64 * 1024 * 1024,
            nativePageBytes <= 64 * 1024 * 1024, nativeBytes <= 256 * 1024 * 1024,
            jsPageBytes >= maxFrameBytes, nativePageBytes >= maxFrameBytes,
            nativeBytes >= nativePageBytes, nativeMessages >= nativePageMessages,
            nativeOutboundWindow <= 64, nativeOutboundGlobalWindow <= 512,
            nativeOutboundGlobalWindow >= maxChannels, nativeBatchSize <= 512,
            nativeBatchSize <= nativeMessages
        else { throw URNContainerError("INVALID_BUDGET", "预算超限或单帧、单页、总量关系不一致") }
    }
}
