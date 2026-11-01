package com.urn.sdk.routing

import com.aeris.sdk.AerisRNNativeTransport
import com.aeris.sdk.BridgeConnection
import com.aeris.sdk.BridgeUIContext

/** 每页独立 Transport/Connection；公开操作仍经过 Router 的退役和计量入口。 */
class URNPageConnection internal constructor(
    val address: URNAddress,
    val uiContext: BridgeUIContext?,
    internal val transport: AerisRNNativeTransport,
    private val router: URNChannelRouter,
) {
    val connection: BridgeConnection get() = transport.connection
    val isClosed: Boolean get() = connection.isClosed
    val isClosing: Boolean get() = connection.isClosing
    fun receive(message: String): Boolean = router.receive(address, message)
    fun beginClosing() = router.beginClosing(address)
    fun close() = router.close(address)
}
