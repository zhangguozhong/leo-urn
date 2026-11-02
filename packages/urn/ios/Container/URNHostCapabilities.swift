import Foundation

/// 不包含凭据的值快照；每次变化由宿主递增revision。
public struct URNHostEnvironment: Sendable {
    public let revision: Int
    public let theme: String
    public let locale: String
    public let fontScale: Double
    public let width: Double
    public let height: Double
    public let userDomain: String
    public init(
        revision: Int = 1, theme: String = "system", locale: String = "und", fontScale: Double = 1,
        width: Double = 0, height: Double = 0, userDomain: String = "anonymous"
    ) {
        self.revision = revision
        self.theme = theme
        self.locale = locale
        self.fontScale = fontScale
        self.width = width
        self.height = height
        self.userDomain = userDomain
    }
    func validate() throws {
        guard revision >= 1, revision <= 9007199254740991,
            ["system", "dark", "light"].contains(theme),
            locale.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil,
            fontScale.isFinite, fontScale > 0, fontScale <= 10,
            [width, height].allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= 100000 }),
            userDomain.range(of: "^[A-Za-z0-9._-]{1,128}$", options: .regularExpression) != nil
        else { throw URNContainerError("INVALID_ENVIRONMENT", "宿主环境快照非法") }
    }
    var json: [String: Any] {
        [
            "revision": revision, "theme": theme, "locale": locale, "fontScale": fontScale,
            "window": ["width": width, "height": height], "userDomain": userDomain,
        ]
    }
}
public struct URNModuleManifest: Sendable {
    public let featureId: String
    public let version: String
    public let requiredCapabilities: Set<String>
    public let paramsContract: String?
    public let baselineId: String?
    public init(
        featureId: String, version: String, requiredCapabilities: Set<String> = [],
        paramsContract: String? = nil, baselineId: String? = nil
    ) {
        self.featureId = featureId
        self.version = version
        self.requiredCapabilities = requiredCapabilities
        self.paramsContract = paramsContract
        self.baselineId = baselineId
    }
    static func validate(_ modules: [URNModuleManifest]) throws {
        guard Set(modules.map(\.featureId)).count == modules.count else {
            throw URNContainerError("DUPLICATE_MODULE", "模块声明重复")
        }
        for module in modules {
            guard
                module.featureId.range(
                    of: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$", options: .regularExpression) != nil,
                module.version.range(
                    of: "^\\d+\\.\\d+\\.\\d+(?:[-+][A-Za-z0-9.-]+)?$", options: .regularExpression)
                    != nil,
                module.requiredCapabilities.allSatisfy({
                    $0.range(of: "^[a-z][a-z0-9._-]{0,79}$", options: .regularExpression) != nil
                }),
                [module.paramsContract, module.baselineId].allSatisfy({
                    $0 == nil || (($0?.isEmpty == false) && ($0?.count ?? 0) <= 128)
                })
            else { throw URNContainerError("INVALID_MODULE", "模块版本、能力或契约声明非法") }
        }
    }
    static func preflight(
        featureId: String, modules: [URNModuleManifest], capabilities: Set<String>,
        baselineId: String
    ) throws {
        guard let module = modules.first(where: { $0.featureId == featureId }) else { return }
        guard module.requiredCapabilities.isSubset(of: capabilities) else {
            throw URNContainerError("CAPABILITY_MISSING", "宿主缺少模块要求的能力")
        }
        guard module.baselineId == nil || module.baselineId == baselineId else {
            throw URNContainerError("BASELINE_MISMATCH", "模块要求不同基线")
        }
    }
}

/// NotificationCenter持有回调；此token对象随Coordinator释放时撤销观察。
final class URNMemoryObservation {
    private let token: NSObjectProtocol
    init(_ token: NSObjectProtocol) { self.token = token }
    deinit { NotificationCenter.default.removeObserver(token) }
}
