import Foundation
import UIKit

public enum URNRouteTarget {
    case rn(String)
    case native(String)
    case flutter(String)
    case web(URL)
    var identity: String {
        switch self {
        case .rn(let value): return "rn:\(value)"
        case .native(let value): return "native:\(value)"
        case .flutter(let value): return "flutter:\(value)"
        case .web(let value): return "web:\(value.absoluteString)"
        }
    }
}
/// close必须在UI与业务资源真正清理后确认；失败仍由路由表保留owner。
fileprivate struct URNRestorationBinding: Equatable {
    let userDomain: String
    let modules: String
    let target: String
}
@MainActor public final class URNRouteOwner {
    fileprivate private(set) var restorationBinding: URNRestorationBinding?
    fileprivate func bindRestoration(_ binding: URNRestorationBinding, allowExisting: Bool) throws {
        if let previous = restorationBinding {
            if allowExisting, previous == binding { return }
            throw URNContainerError(
                allowExisting ? "OWNER_ALREADY_BOUND" : "OWNER_REUSED", "owner创建域和模块身份不能重标或复用")
        }
        restorationBinding = binding
    }
    public let id: String
    public let page: URNPageHandle?
    private let cleanup: (@escaping (Result<Void, Error>) -> Void) -> Void
    public let capture: (@escaping (Result<Any, Error>) -> Void) -> Void
    public let restore: (Any, @escaping (Result<Void, Error>) -> Void) -> Void
    public init(
        id: String, page: URNPageHandle? = nil,
        close: @escaping (@escaping (Result<Void, Error>) -> Void) -> Void,
        capture: @escaping (@escaping (Result<Any, Error>) -> Void) -> Void = {
            $0(.success(NSNull()))
        },
        restore: @escaping (Any, @escaping (Result<Void, Error>) -> Void) -> Void = { state, done in
            if state is NSNull {
                done(.success(()))
            } else {
                done(.failure(URNContainerError("RESTORE_UNAVAILABLE", "未提供业务恢复钩子")))
            }
        }
    ) {
        self.id = id
        self.page = page
        self.cleanup = close
        self.capture = capture
        self.restore = restore
    }
    public func close(completion: @escaping (Result<Void, Error>) -> Void) { cleanup(completion) }
}
@MainActor public final class URNRouteOperation {
    private let cancellation: (@escaping (Result<Void, Error>) -> Void) -> Void
    public init(cancel: @escaping (@escaping (Result<Void, Error>) -> Void) -> Void) {
        cancellation = cancel
    }
    public func cancel(completion: @escaping (Result<Void, Error>) -> Void = { _ in }) {
        cancellation(completion)
    }
}
@MainActor public struct URNMixedRouting {
    public var routes: [String: URNRouteTarget]
    public var maxQueued = 16
    public var timeout: TimeInterval = 15
    public var failureLimit = 3
    public var failureWindow: TimeInterval = 60
    public var cooldown: TimeInterval = 30
    public var guardRoute:
        (URNRouteTarget, UIViewController, @escaping (Result<Bool, Error>) -> Void) -> Void = {
            _, _, done in done(.success(true))
        }
    public var dispatch:
        (
            URNRouteTarget, [String: Any], UIViewController,
            @escaping (Result<URNRouteOwner, Error>) -> Void
        ) -> URNRouteOperation
    public var fallback: (URNRouteTarget, Error, @escaping (URNRouteTarget?) -> Void) -> Void = {
        _, _, done in done(nil)
    }
    public init(
        routes: [String: URNRouteTarget],
        dispatch:
            @escaping (
                URNRouteTarget, [String: Any], UIViewController,
                @escaping (Result<URNRouteOwner, Error>) -> Void
            ) -> URNRouteOperation
    ) {
        self.routes = routes
        self.dispatch = dispatch
    }
    func validate() throws {
        guard (1...64).contains(maxQueued), timeout.isFinite, timeout > 0, timeout <= 300,
            (1...100).contains(failureLimit), failureWindow.isFinite, failureWindow > 0,
            cooldown.isFinite, cooldown > 0, routes.count <= 256
        else { throw URNContainerError("INVALID_CONFIGURATION", "混合路由预算非法") }
        for (path, target) in routes {
            guard path.range(of: "^/[A-Za-z0-9/_-]{0,255}$", options: .regularExpression) != nil
            else { throw URNContainerError("INVALID_ROUTE", "注册路由路径非法") }
            try Self.validateTarget(target)
        }
    }
    static func validateTarget(_ target: URNRouteTarget) throws {
        guard target.identity.utf8.count <= 2048 else {
            throw URNContainerError("INVALID_ROUTE", "路由目标过长")
        }
        switch target {
        case .rn(let id):
            guard
                id.range(of: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$", options: .regularExpression)
                    != nil
            else { throw URNContainerError("INVALID_ROUTE", "RN业务标识非法") }
        case .native(let route), .flutter(let route):
            guard !route.isEmpty else { throw URNContainerError("INVALID_ROUTE", "路由目标为空") }
        case .web(let url):
            guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil,
                url.user == nil, url.password == nil
            else { throw URNContainerError("INVALID_ROUTE", "Web仅接受HTTP/HTTPS") }
        }
    }
}

@MainActor final class URNMixedRouter {
    private final class Entry {
        let id = UUID().uuidString
        let key: String
        let source: String?
        let epoch: UUID
        let domain: String
        let target: URNRouteTarget
        let params: [String: Any]
        let controller: UIViewController
        var cancelled = false
        var settled = false
        var dispatched = false
        var dispatching = false
        var cancellationStarted = false
        var operation: URNRouteOperation?
        var owner: URNRouteOwner?
        var work: DispatchWorkItem?
        var callbacks: [(Result<URNRouteOwner, Error>) -> Void] = []
        var cancelCallbacks: [(Result<Void, Error>) -> Void] = []
        var cancellationResult: Result<Void, Error>?
        var cancelOperationResult: Result<Void, Error>?
        var dispatchCleanupResult: Result<Void, Error>?
        init(
            key: String, source: String?, epoch: UUID, domain: String, target: URNRouteTarget,
            params: [String: Any], controller: UIViewController
        ) {
            self.key = key
            self.source = source
            self.epoch = epoch
            self.domain = domain
            self.target = target
            self.params = params
            self.controller = controller
        }
    }
    private let configuration: URNMixedRouting
    private let moduleIdentity: () -> String
    private var epoch = UUID()
    private var domain = "anonymous"
    private var ready = true
    private var restoring = false
    private var restoreSource: String?
    private var restoreCancelled = false
    private var cancelRestore: ((@escaping (Result<Void, Error>) -> Void) -> Void)?
    private var cancelling: [String: Entry] = [:]
    private var cleanupSources: [ObjectIdentifier: String] = [:]
    private var releasing: [ObjectIdentifier: [(Result<Void, Error>) -> Void]] = [:]
    private var entries: [String: Entry] = [:]
    private var cleanup: [ObjectIdentifier: URNRouteOwner] = [:]
    private var failureTimes: [String: [Date]] = [:]
    private var blockedUntil: [String: Date] = [:]
    var pendingCleanupCount: Int { cleanup.count }
    init(_ configuration: URNMixedRouting, moduleIdentity: @escaping () -> String = { "" }) {
        self.configuration = configuration
        self.moduleIdentity = moduleIdentity
    }
    func setReady(_ value: Bool) {
        ready = value
        if value { for entry in Array(entries.values) { run(entry) } }
    }
    func setDomain(_ value: String) {
        guard domain != value else { return }
        domain = value
        invalidate() { _ in }
    }
    func invalidate(
        source: String? = nil, completion: @escaping (Result<Void, Error>) -> Void = { _ in }
    ) {
        if source == nil { epoch = UUID() }
        if source == nil || (restoring && source == restoreSource) { restoreCancelled = true }
        var selected: [String: Entry] = [:]
        for entry in Array(entries.values) + Array(cancelling.values)
        where source == nil || entry.source == source { selected[entry.id] = entry }
        let owners = cleanup.values.filter {
            source == nil || cleanupSources[ObjectIdentifier($0)] == source
        }
        let restoreCancellation = (source == nil || source == restoreSource) ? cancelRestore : nil
        var pending = selected.count + owners.count + (restoreCancellation == nil ? 0 : 1)
        guard pending > 0 else {
            completion(.success(()))
            return
        }
        var failure: Error?
        func done(_ result: Result<Void, Error>) {
            if case .failure(let error) = result { failure = error }
            pending -= 1
            if pending == 0 { completion(failure.map { .failure($0) } ?? .success(())) }
        }
        restoreCancellation?(done)
        for entry in selected.values { cancel(entry, completion: done) }
        for owner in owners { release(owner, completion: done) }
    }
    private func valid(_ entry: Entry) -> Bool {
        !entry.cancelled && entry.epoch == epoch && entry.domain == domain
    }
    func open(
        _ url: URL, params: [String: Any], source: String?, from controller: UIViewController,
        completion: @escaping (Result<URNRouteOwner, Error>) -> Void
    ) throws -> URNRouteOperation {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
            parts.fragment == nil, parts.user == nil, parts.password == nil,
            let target = configuration.routes[parts.path]
        else { throw URNContainerError("ROUTE_NOT_FOUND", "深链未注册或不合法") }
        var merged: [String: Any] = [:]
        for item in parts.queryItems ?? [] { merged[item.name] = item.value ?? "" }
        merged.merge(params) { _, value in value }
        guard JSONSerialization.isValidJSONObject(merged) else {
            throw URNContainerError("INVALID_PARAMS", "路由参数须为JSON")
        }
        let data = try JSONSerialization.data(withJSONObject: merged, options: .sortedKeys)
        guard data.count <= 16384,
            let snapshot = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw URNContainerError("INVALID_PARAMS", "路由参数超过16KB") }
        let key = "\(source ?? "external"):\(parts.path):\(data.base64EncodedString())"
        if let existing = entries[key] {
            existing.callbacks.append(completion)
            return URNRouteOperation { done in self.cancel(existing, completion: done) }
        }
        guard entries.count + cleanup.count + cancelling.count < configuration.maxQueued else {
            throw URNContainerError("ROUTE_LIMIT", "冷启动路由队列已满")
        }
        let entry = Entry(
            key: key, source: source, epoch: epoch, domain: domain, target: target,
            params: snapshot, controller: controller)
        entry.callbacks.append(completion)
        entries[key] = entry
        let deadline = DispatchWorkItem { [weak self, weak entry] in
            guard let self, let entry else { return }
            self.cancel(entry, error: URNContainerError("ROUTE_TIMEOUT", "路由超过期限")) { _ in }
        }
        entry.work = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + configuration.timeout, execute: deadline)
        if ready { run(entry) }
        return URNRouteOperation { done in self.cancel(entry, completion: done) }
    }
    private func settle(_ entry: Entry, _ result: Result<URNRouteOwner, Error>) {
        guard !entry.settled else { return }
        entry.settled = true
        entry.work?.cancel()
        entries.removeValue(forKey: entry.key)
        let callbacks = entry.callbacks
        entry.callbacks.removeAll()
        callbacks.forEach { $0(result) }
    }
    private func run(_ entry: Entry) {
        guard valid(entry), !entry.dispatched else { return }
        entry.dispatched = true
        var guardReported = false
        configuration.guardRoute(entry.target, entry.controller) { [weak self] result in
            guard let self, self.valid(entry), !guardReported else { return }
            guardReported = true
            switch result {
            case .failure(let error): self.settle(entry, .failure(error))
            case .success(false):
                self.settle(entry, .failure(URNContainerError("ROUTE_DENIED", "宿主拒绝路由")))
            case .success(true):
                if let until = self.blockedUntil[entry.target.identity], until > Date() {
                    self.failed(entry, URNContainerError("CIRCUIT_OPEN", "路由熔断冷却中"))
                    return
                }
                self.dispatch(entry, target: entry.target, fallbackError: nil)
            }
        }
    }
    private func dispatch(_ entry: Entry, target: URNRouteTarget, fallbackError: Error?) {
        var responded = false
        entry.dispatching = true
        let operation = configuration.dispatch(target, entry.params, entry.controller) {
            [weak self] result in
            guard let self, !responded else { return }
            responded = true
            entry.operation = nil
            switch result {
            case .success(let owner):
                do {
                    try owner.bindRestoration(
                        URNRestorationBinding(
                            userDomain: entry.domain, modules: self.moduleIdentity(),
                            target: target.identity), allowExisting: false)
                } catch {
                    if entry.cancelled {
                        entry.dispatchCleanupResult = .failure(error)
                        self.tryFinishCancel(entry)
                    } else {
                        self.settle(entry, .failure(error))
                    }
                    return
                }
                entry.owner = owner
                if !self.valid(entry) {
                    self.cleanupSources[ObjectIdentifier(owner)] = entry.source ?? "external"
                    self.release(owner) { outcome in
                        entry.dispatchCleanupResult = outcome
                        self.tryFinishCancel(entry)
                    }
                    return
                }
                if let fallbackError {
                    self.cleanupSources[ObjectIdentifier(owner)] = entry.source ?? "external"
                    self.cleanup[ObjectIdentifier(owner)] = owner
                    self.settle(entry, .failure(fallbackError))
                } else {
                    self.settle(entry, .success(owner))
                }
            case .failure(let error):
                if entry.cancelled {
                    entry.dispatchCleanupResult = .success(())
                    self.tryFinishCancel(entry)
                } else if fallbackError != nil {
                    self.settle(entry, .failure(error))
                } else {
                    self.failed(entry, error)
                }
            }
        }
        entry.dispatching = false
        if !responded { entry.operation = operation }
        if entry.cancelled { cancelOperation(entry, operation) }
    }
    private func failed(_ entry: Entry, _ error: Error) {
        guard valid(entry) else { return }
        if let code = (error as? URNContainerError)?.code,
            [
                "CAPABILITY_MISSING", "BASELINE_MISMATCH", "INVALID_PARAMS", "PERMISSION_DENIED",
                "ROUTE_DENIED",
            ].contains(code)
        {
            settle(entry, .failure(error))
            return
        }
        let key = entry.target.identity
        let now = Date()
        for candidate in Array(failureTimes.keys) {
            let recent = (failureTimes[candidate] ?? []).filter {
                now.timeIntervalSince($0) < configuration.failureWindow
            }
            if recent.isEmpty && (blockedUntil[candidate] ?? .distantPast) <= now {
                failureTimes.removeValue(forKey: candidate)
                blockedUntil.removeValue(forKey: candidate)
            } else {
                failureTimes[candidate] = recent
            }
        }
        if (error as? URNContainerError)?.code != "CIRCUIT_OPEN" {
            let recent = (failureTimes[key] ?? []).suffix(max(0, configuration.failureLimit - 1))
            let times = Array(recent) + [now]
            failureTimes[key] = times
            if times.count >= configuration.failureLimit {
                blockedUntil[key] = now.addingTimeInterval(configuration.cooldown)
            }
        }
        var called = false
        configuration.fallback(entry.target, error) { [weak self, weak entry] target in
            guard let self, let entry, self.valid(entry), !called else { return }
            called = true
            if let target, target.identity != entry.target.identity {
                do {
                    try URNMixedRouting.validateTarget(target)
                    self.dispatch(entry, target: target, fallbackError: error)
                } catch { self.settle(entry, .failure(error)) }
            } else {
                self.settle(entry, .failure(error))
            }
        }
    }
    private func cancel(
        _ entry: Entry, error: Error = URNContainerError("CANCELLED", "路由已取消"),
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        if let previous = entry.cancellationResult {
            completion(previous)
            return
        }
        if entry.settled && !entry.cancelled {
            completion(.success(()))
            return
        }
        entry.cancelCallbacks.append(completion)
        guard !entry.cancelled else { return }
        entry.cancelled = true
        cancelling[entry.id] = entry
        settle(entry, .failure(error))
        if let operation = entry.operation {
            cancelOperation(entry, operation)
        } else if !entry.dispatching {
            finishCancel(entry, .success(()))
        }
    }
    private func cancelOperation(_ entry: Entry, _ operation: URNRouteOperation) {
        guard !entry.cancellationStarted else { return }
        entry.cancellationStarted = true
        operation.cancel { result in
            entry.cancelOperationResult = result
            if case .failure = result {
                let lease = URNRouteOwner(
                    id: "cancel:" + entry.id, close: { done in operation.cancel(completion: done) })
                self.cleanup[ObjectIdentifier(lease)] = lease
                self.cleanupSources[ObjectIdentifier(lease)] = entry.source ?? "external"
            }
            self.tryFinishCancel(entry)
        }
    }
    private func tryFinishCancel(_ entry: Entry) {
        guard let cancellation = entry.cancelOperationResult,
            let cleanup = entry.dispatchCleanupResult
        else { return }
        if case .failure = cancellation {
            finishCancel(entry, cancellation)
        } else {
            finishCancel(entry, cleanup)
        }
    }
    private func finishCancel(_ entry: Entry, _ result: Result<Void, Error>) {
        guard entry.cancellationResult == nil else { return }
        entry.cancellationResult = result
        cancelling.removeValue(forKey: entry.id)
        let callbacks = entry.cancelCallbacks
        entry.cancelCallbacks.removeAll()
        callbacks.forEach { $0(result) }
    }
    private func release(
        _ owner: URNRouteOwner, completion: @escaping (Result<Void, Error>) -> Void
    ) {
        cleanup[ObjectIdentifier(owner)] = owner
        if releasing[ObjectIdentifier(owner)] != nil {
            releasing[ObjectIdentifier(owner)]?.append(completion)
            return
        }
        releasing[ObjectIdentifier(owner)] = [completion]
        var responded = false
        owner.close { result in
            guard !responded else { return }
            responded = true
            if case .success = result {
                self.cleanup.removeValue(forKey: ObjectIdentifier(owner))
                self.cleanupSources.removeValue(forKey: ObjectIdentifier(owner))
            }
            let callbacks = self.releasing.removeValue(forKey: ObjectIdentifier(owner)) ?? []
            callbacks.forEach { $0(result) }
        }
    }
    func retryCleanup(source: String? = nil, completion: @escaping (Result<Void, Error>) -> Void) {
        let owners = cleanup.values.filter {
            source == nil || cleanupSources[ObjectIdentifier($0)] == source
        }
        guard !owners.isEmpty else {
            completion(.success(()))
            return
        }
        var pending = owners.count
        var failure: Error?
        for owner in owners {
            release(owner) { result in
                if case .failure(let error) = result { failure = error }
                pending -= 1
                if pending == 0 { completion(failure.map { .failure($0) } ?? .success(())) }
            }
        }
    }
    func registerRestorationOwner(_ owner: URNRouteOwner, userDomain: String, route: String) throws
    {
        guard userDomain.range(of: "^[A-Za-z0-9._-]{1,128}$", options: .regularExpression) != nil,
            let target = configuration.routes[route]
        else { throw URNContainerError("INVALID_RESTORATION_OWNER", "宿主须显式提供合法创建域和已注册路由") }
        try owner.bindRestoration(
            URNRestorationBinding(
                userDomain: userDomain, modules: moduleIdentity(), target: target.identity),
            allowExisting: true)
    }
    func capture(
        _ pages: [URNRestorableRoute], baseline: String, modules: String,
        completion: @escaping (Result<Data, Error>) -> Void
    ) {
        let token = epoch
        let user = domain
        guard pages.count <= 16 else {
            completion(.failure(URNContainerError("SNAPSHOT_LIMIT", "快照页面超过预算")))
            return
        }
        var values: [[String: Any]] = []
        @MainActor func next(_ index: Int) {
            guard token == epoch, user == domain else {
                completion(.failure(URNContainerError("CANCELLED", "捕获期间用户域或轮次改变")))
                return
            }
            guard index < pages.count else {
                do {
                    let object: [String: Any] = [
                        "version": 1, "baselineId": baseline, "modules": modules,
                        "userDomain": user, "pages": values,
                    ]
                    guard JSONSerialization.isValidJSONObject(object) else {
                        throw URNContainerError("SNAPSHOT_INVALID", "业务状态须为JSON")
                    }
                    let data = try JSONSerialization.data(withJSONObject: object)
                    guard data.count <= 262144 else {
                        throw URNContainerError("SNAPSHOT_LIMIT", "快照超过256KB")
                    }
                    completion(.success(data))
                } catch { completion(.failure(error)) }
                return
            }
            let page = pages[index]
            guard let target = configuration.routes[page.route] else {
                completion(.failure(URNContainerError("ROUTE_NOT_FOUND", "快照路由未注册")))
                return
            }
            guard let binding = page.owner.restorationBinding else {
                completion(
                    .failure(URNContainerError("SNAPSHOT_OWNER_UNBOUND", "外部owner须由宿主显式登记创建域")))
                return
            }
            guard binding.userDomain == user else {
                completion(
                    .failure(
                        URNContainerError("SNAPSHOT_OWNER_DOMAIN_MISMATCH", "不能把旧用户owner重标为当前用户快照"))
                )
                return
            }
            guard binding.modules == modules, binding.target == target.identity else {
                completion(
                    .failure(URNContainerError("SNAPSHOT_OWNER_INCOMPATIBLE", "owner不属于当前模块版本或路由")))
                return
            }
            var responded = false
            page.owner.capture { result in
                guard !responded else { return }
                responded = true
                switch result {
                case .failure(let error): completion(.failure(error))
                case .success(let state):
                    values.append(["route": page.route, "params": page.params, "state": state])
                    next(index + 1)
                }
            }
        }
        next(0)
    }
    func restore(
        read: (@escaping (Result<Data, Error>) -> Void) -> Void, baseline: String, modules: String,
        from controller: UIViewController, sourcePageId: String?,
        completion: @escaping (Result<[URNRouteOwner], Error>) -> Void
    ) {
        guard !restoring else {
            completion(.failure(URNContainerError("RESTORE_BUSY", "正在恢复快照")))
            return
        }
        restoring = true
        restoreSource = sourcePageId
        restoreCancelled = false
        let token = epoch
        let user = domain
        var created: [URNRouteOwner] = []
        var completed = false
        var rollingBack = false
        var cancellationCallbacks: [(Result<Void, Error>) -> Void] = []
        func finish(_ result: Result<[URNRouteOwner], Error>) {
            guard !completed else { return }
            completed = true
            restoring = false
            cancelRestore = nil
            let cleanupResult: Result<Void, Error>
            if case .failure(let error) = result,
                (error as? URNContainerError)?.code == "RESTORE_ROLLBACK_FAILED"
            {
                cleanupResult = .failure(error)
            } else {
                cleanupResult = .success(())
            }
            cancellationCallbacks.forEach { $0(cleanupResult) }
            cancellationCallbacks.removeAll()
            completion(result)
        }
        func rollback(_ error: Error) {
            guard !completed, !rollingBack else { return }
            rollingBack = true
            var left = created.count
            var failed = false
            guard left > 0 else {
                finish(.failure(error))
                return
            }
            for owner in created.reversed() {
                cleanupSources[ObjectIdentifier(owner)] = sourcePageId ?? "external"
                release(owner) { result in
                    if case .failure = result { failed = true }
                    left -= 1
                    if left == 0 {
                        finish(
                            .failure(
                                failed
                                    ? URNContainerError(
                                        "RESTORE_ROLLBACK_FAILED", "回滚清理失败，owner仍保留供重试") : error))
                    }
                }
            }
        }
        cancelRestore = { done in
            cancellationCallbacks.append(done)
            self.restoreCancelled = true
            rollback(URNContainerError("CANCELLED", "来源页面已关闭或用户域已改变"))
        }
        func valid() -> Bool {
            !completed && token == epoch && user == domain && !restoreCancelled
                && controller.viewIfLoaded?.window != nil
        }
        var readDone = false
        read { result in
            guard !readDone, !completed else { return }
            readDone = true
            guard valid() else {
                rollback(URNContainerError("CANCELLED", "读取期间用户域或轮次改变"))
                return
            }
            do {
                let data = try result.get()
                guard data.count <= 262144,
                    let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                    value["version"] as? Int == 1, value["baselineId"] as? String == baseline,
                    value["modules"] as? String == modules, value["userDomain"] as? String == user,
                    let pages = value["pages"] as? [[String: Any]], pages.count <= 16
                else { throw URNContainerError("SNAPSHOT_INCOMPATIBLE", "快照损坏或与用户域、模块版本、基线不兼容") }
                for page in pages {
                    guard let path = page["route"] as? String,
                        self.configuration.routes[path] != nil, page["params"] is [String: Any],
                        page["state"] != nil
                    else { throw URNContainerError("SNAPSHOT_INCOMPATIBLE", "快照页面损坏") }
                }
                @MainActor func next(_ index: Int) {
                    guard valid() else {
                        rollback(URNContainerError("CANCELLED", "恢复期间用户域或轮次改变"))
                        return
                    }
                    guard index < pages.count else {
                        finish(.success(created))
                        return
                    }
                    let page = pages[index]
                    guard let path = page["route"] as? String, let url = URL(string: path),
                        let params = page["params"] as? [String: Any], let state = page["state"]
                    else {
                        rollback(URNContainerError("SNAPSHOT_INCOMPATIBLE", "快照页面损坏"))
                        return
                    }
                    do {
                        _ = try self.open(
                            url, params: params,
                            source: sourcePageId ?? "restore-\(token)-\(index)", from: controller
                        ) { result in
                            switch result {
                            case .failure(let error): rollback(error)
                            case .success(let owner):
                                created.append(owner)
                                guard valid() else {
                                    rollback(URNContainerError("CANCELLED", "恢复期间用户域或轮次改变"))
                                    return
                                }
                                var applied = false
                                owner.restore(state) { result in
                                    guard !applied else { return }
                                    applied = true
                                    switch result {
                                    case .failure(let error): rollback(error)
                                    case .success: next(index + 1)
                                    }
                                }
                            }
                        }
                    } catch { rollback(error) }
                }
                next(0)
            } catch { rollback(error) }
        }
    }
    func resetCircuit() {
        failureTimes.removeAll()
        blockedUntil.removeAll()
    }
}

public struct URNRestorableRoute {
    public let route: String
    public let params: [String: Any]
    public let owner: URNRouteOwner
    public init(route: String, params: [String: Any] = [:], owner: URNRouteOwner) {
        self.route = route
        self.params = params
        self.owner = owner
    }
}

/// 原生页面清理与跨栈UI取消是两个独立屏障；各自只接纳一次结果。
@MainActor final class URNRouteCloseBarrier {
    private var results: [Int: Result<Void, Error>] = [:]
    private let completion: (Result<Void, Error>) -> Void
    init(_ completion: @escaping (Result<Void, Error>) -> Void) { self.completion = completion }
    func complete(_ index: Int, _ result: Result<Void, Error>) {
        guard results[index] == nil else { return }
        results[index] = result
        guard results.count == 2 else { return }
        for value in results.values {
            if case .failure = value {
                completion(value)
                return
            }
        }
        completion(.success(()))
    }
}
