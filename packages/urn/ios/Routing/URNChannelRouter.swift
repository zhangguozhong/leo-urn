import Aeris
import AerisHost
import Foundation

/// 同一运行轮次的一张连接表：单页、多页使用完全相同的算法。
@MainActor final class URNChannelRouter {
    private let engine: BridgeEngine
    let generation: String
    private let maxPages: Int
    private let maxRetiredChannels: Int
    private let emit: (URNAddress, String) -> Void
    private var pages: [URNAddress: URNPageConnection] = [:]
    private var opening = Set<URNAddress>()
    private var closingDuringOpen = Set<URNAddress>()
    private var retired = Set<URNAddress>()
    private var isClosed = false
    var count: Int { pages.count }

    init(
        engine: BridgeEngine, generation: String, maxPages: Int,
        maxRetiredChannels: Int = URNChannelBudget().maxRetiredChannels,
        emit: @escaping (URNAddress, String) -> Void
    ) {
        self.engine = engine
        self.generation = generation
        self.maxPages = min(64, max(1, maxPages))
        self.maxRetiredChannels = maxRetiredChannels
        self.emit = emit
    }

    func open(
        _ address: URNAddress, uiContext: BridgeUIContext?, allowedPermissions: Set<String>,
        allowedEventTopics: Set<String>?
    ) throws {
        guard !isClosed, address.isValid, address.generation == generation else {
            throw URNContainerError("INVALID_CHANNEL", "通道地址不属于当前活动运行轮次")
        }
        guard pages[address] == nil, !opening.contains(address), !retired.contains(address) else {
            throw URNContainerError("CHANNEL_RETIRED", "通道地址不能重复绑定或重新启用")
        }
        guard pages.count + opening.count < maxPages, retired.count < maxRetiredChannels else {
            throw URNContainerError("PAGE_LIMIT", "页面或退役通道达到预算，请关闭页面或重建运行时")
        }
        opening.insert(address)
        defer {
            opening.remove(address)
            closingDuringOpen.remove(address)
        }
        let factory = try AerisHostReceiverFactory(
            configuration: AerisHostConfiguration(
                engine: engine, allowedPermissions: allowedPermissions,
                allowedEventTopics: allowedEventTopics), source: .reactNative, uiContext: uiContext)
        let page = try URNPageConnection(
            address: address, uiContext: uiContext, receiverFactory: factory,
            closeFactory: { factory.close() }
        ) { [weak self] text in
            guard let self, self.pages[address] != nil, !self.isClosed else { return }
            self.emit(address, text)
        }
        guard !isClosed, !retired.contains(address) else {
            page.close()
            throw URNContainerError("CLOSED", "通道构造期间已关闭")
        }
        if closingDuringOpen.contains(address) { page.beginClosing() }
        pages[address] = page
    }

    func receive(_ address: URNAddress, message: String) {
        guard !isClosed, address.generation == generation else { return }
        pages[address]?.receive(message)
    }

    func beginClosing(_ address: URNAddress) {
        if opening.contains(address) { closingDuringOpen.insert(address) }
        pages[address]?.beginClosing()
    }

    func close(_ address: URNAddress) {
        // 先退役再触发业务取消，防止回调重入重新注册相同地址。
        guard let page = pages.removeValue(forKey: address) else {
            if opening.contains(address) { retired.insert(address) }
            return
        }
        retired.insert(address)
        page.close()
    }

    func closeAll() {
        guard !isClosed else { return }
        isClosed = true
        let active = Array(pages.values)
        pages.removeAll()
        retired.removeAll()
        active.forEach { $0.close() }
    }
}
