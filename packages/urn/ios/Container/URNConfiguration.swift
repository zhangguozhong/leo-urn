import Aeris
import Foundation

/// 一份配置对应一个共享 RN 运行时；React/RN 基线不能由页面临时更改。
@MainActor public struct URNConfiguration {
    public let engine: BridgeEngine
    public let baselineId: String
    public let bundleURL: URL
    public let dependencyProvider: AnyObject
    public var navigator: any URNPageNavigating = URNUIKitNavigator()
    public var pageUI = URNPageUI()
    /// 目标页权限由宿主重新决定，可通过抛错拒绝跳转，不继承调用页的权限。
    public var navigationPageConfiguration: (URNPageHandle, String) throws -> URNPageConfiguration =
        { _, _ in .init() }
    public var maxPages = 16
    public var channelBudget = URNChannelBudget()
    /// 每次导航打开/关闭的原生期限；取消确认不代表 UIKit 已移除页面。
    public var navigationTimeout: TimeInterval = 15
    public var startupTimeout: TimeInterval = 20
    public var closeWindow: TimeInterval = 2
    public var cleanupTimeout: TimeInterval = 15
    public var onDiagnostic: (String, String) -> Void = { _, _ in }
    public var onDiagnosticEvent: ((URNDiagnostic) -> Void)?
    public var includeFeatureIdsInDiagnostics = false

    public init(
        engine: BridgeEngine, baselineId: String, bundleURL: URL, dependencyProvider: AnyObject
    ) throws {
        guard URNAddress(generation: baselineId, channel: "check").isValid else {
            throw URNContainerError("INVALID_BASELINE", "基线标识必须为 1 至 80 位字母、数字、横线或下划线")
        }
        guard ["http", "https", "file"].contains(bundleURL.scheme?.lowercased() ?? "") else {
            throw URNContainerError("INVALID_BUNDLE_URL", "bundle 必须来自显式 Metro URL 或本地文件")
        }
        if bundleURL.isFileURL && !FileManager.default.fileExists(atPath: bundleURL.path) {
            throw URNContainerError("BUNDLE_MISSING", "找不到内置 RN bundle，不能回退到 Metro")
        }
        self.engine = engine
        self.baselineId = baselineId
        self.bundleURL = bundleURL
        self.dependencyProvider = dependencyProvider
    }
    func validate() throws {
        try channelBudget.validate()
        guard (1...64).contains(maxPages), maxPages <= channelBudget.maxChannels,
            [startupTimeout, closeWindow, cleanupTimeout, navigationTimeout].allSatisfy({
                $0.isFinite && $0 > 0 && $0 <= 300
            })
        else {
            throw URNContainerError(
                "INVALID_CONFIGURATION",
                "maxPages须在1至64且不超过channelBudget.maxChannels；等待期限须为0至300秒内有限正数")
        }
    }

    var effectiveChannelBudget: [String: Int] {
        var budget = channelBudget.values
        budget["maxChannels"] = maxPages
        return budget
    }

}

/// 权限、topic 和业务资源屏障由宿主按页面注入，不写死在公共容器中。
@MainActor public struct URNPageConfiguration {
    public var allowedPermissions: Set<String> = []
    public var allowedEventTopics: Set<String>?
    public var cleanup: (@escaping @MainActor (Result<Void, Error>) -> Void) -> Void = { done in
        done(.success(()))
    }
    public init() {}
}
