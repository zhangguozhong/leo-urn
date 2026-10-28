import Aeris
import AerisContracts
import Foundation

/// 每页独立接收器与上下文；取消、订阅和请求校验仍交给外部 Aeris。
@MainActor final class URNPageConnection {
    let address: URNAddress
    let uiContext: BridgeUIContext?
    private var receiver: (any AerisMessageReceiver)?
    private var closeFactory: (() -> Void)?
    private(set) var isClosing = false
    private(set) var isClosed = false

    init(
        address: URNAddress, uiContext: BridgeUIContext?,
        receiverFactory: any AerisMessageReceiverFactory, closeFactory: @escaping () -> Void,
        emit: @escaping (String) -> Void
    ) throws {
        self.address = address
        self.uiContext = uiContext
        self.closeFactory = closeFactory
        let receiver = receiverFactory.makeReceiver(emitter: emit)
        guard receiver is any AerisClosingMessageReceiver else {
            receiver.close()
            closeFactory()
            uiContext?.invalidate()
            throw URNContainerError(
                "AERIS_CAPABILITY_MISSING", "Aeris Receiver 必须提供已验证的 beginClosing 能力，请核对固定源码来源")
        }
        self.receiver = receiver
    }

    func receive(_ text: String) {
        guard !isClosed else { return }
        receiver?.receiveMessage(text)
    }

    func beginClosing() {
        guard !isClosed, !isClosing else { return }
        isClosing = true
        (receiver as? any AerisClosingMessageReceiver)?.beginClosing()
    }

    func close() {
        guard !isClosed else { return }
        isClosed = true
        let receiver = receiver
        let closeFactory = closeFactory
        self.receiver = nil
        self.closeFactory = nil
        receiver?.close()
        closeFactory?()
        uiContext?.invalidate()
    }
}
