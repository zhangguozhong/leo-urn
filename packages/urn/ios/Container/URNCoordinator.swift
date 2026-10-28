import Aeris
import Foundation
import UIKit

/// App 持有一个 Coordinator。一个运行时中所有页面走同一张独立连接表。
@MainActor public final class URNCoordinator {
    public enum State: String, Sendable {
        case idle, starting, running, reloading, stopping, failed
    }
    public private(set) var state: State = .idle
    public var pageCount: Int { records.count }
    public var generation: String? { runtime?.generation }
    private var appObservation: URNApplicationObservation?
    private let configuration: URNConfiguration
    private var runtime: URNReactHost?
    private var router: URNChannelRouter?
    private var records: [String: Record] = [:]
    private var reloadCompletion: ((Result<Void, Error>) -> Void)?
    private var shutdownCompletions: [(Result<Void, Error>) -> Void] = []
    private var stoppingRuntime = false
    private var runtimeInitialized = false
    private var bundleBooted = false
    private var runtimeFailure: Error?
    private var bootWork: DispatchWorkItem?
    private var runtimeStartedAt = ProcessInfo.processInfo.systemUptime
    private var runtimeStopStartedAt: TimeInterval?

    private final class Record {
        let handle: URNPageHandle
        let params: [String: Any]
        let configuration: URNPageConfiguration
        var address: URNAddress?
        var recoverable = false
        var lifecycleSeq = 0
        var onResult: ((URNPageResult) -> Void)?
        var result: URNPageResult = .cancelled
        var navigationClosing = false
        var navigationRecoveryFailed = false
        var navigationPending = 0
        var originAddress: URNAddress?
        var originRequestId: String?
        var openPending = false
        var openCancelled = false
        var cancelAttempts = 0
        var navigationEpoch = UUID()
        var navigationOpenWork: DispatchWorkItem?
        var navigationCloseWork: DispatchWorkItem?
        var navigationCloseID: UUID?
        var bridgeReady = false
        var mounted = false
        var disposed = false
        var closing = false
        var closedByOwner = false
        var nativeClosed = false
        var cleanupDone = false
        var closeFailure: Error?
        var cleanupAttempt = UUID()
        var mountAttempt = UUID()
        var startupWork: DispatchWorkItem?
        var closeWork: DispatchWorkItem?
        var cleanupWork: DispatchWorkItem?
        var mountWaitWork: DispatchWorkItem?
        var onReady: ((URNPageHandle, Result<Void, Error>) -> Void)?
        var closeCallbacks: [(Result<Void, Error>) -> Void] = []
        var openedAt = ProcessInfo.processInfo.systemUptime
        var closeStartedAt: TimeInterval?
        var cleanupStartedAt: TimeInterval?

        init(
            handle: URNPageHandle, params: [String: Any], configuration: URNPageConfiguration,
            onReady: @escaping (URNPageHandle, Result<Void, Error>) -> Void
        ) {
            self.handle = handle
            self.params = params
            self.configuration = configuration
            self.onReady = onReady
        }
    }

    public init(configuration: URNConfiguration) {
        self.configuration = configuration
        appObservation = URNApplicationObservation { [weak self] foreground in
            guard let self else { return }
            for record in Array(self.records.values) {
                record.handle.lifecycle.foreground = foreground
                self.publishLifecycle(record)
            }
        }
    }

    public var channelBudgetSnapshot: [String: Int] { configuration.effectiveChannelBudget }

    public var messageQueueSnapshot: [String: Int] {
        var result = runtime?.messageQueueSnapshot().mapValues { $0.intValue } ?? [:]
        result["pages"] = records.count
        return result
    }

    private func diagnostic(
        _ stage: String, record: Record? = nil, code: String? = nil, startedAt: TimeInterval? = nil,
        channelId: String? = nil
    ) {
        guard let observer = configuration.onDiagnosticEvent else { return }
        let queue = runtime?.messageQueueSnapshot()
        let event = URNDiagnostic(
            timestampMs: Date().timeIntervalSince1970 * 1000, stage: stage,
            runtimeGeneration: runtime?.generation, pageId: record?.handle.id,
            channelId: channelId ?? record?.address?.channel,
            featureId: configuration.includeFeatureIdsInDiagnostics
                ? record?.handle.featureId : nil,
            durationMs: startedAt.map {
                max(0, (ProcessInfo.processInfo.systemUptime - $0) * 1000)
            }, code: code, queuedMessages: queue?["messages"]?.intValue,
            queuedBytes: queue?["bytes"]?.intValue)
        // 观察器拿到值快照后再回主队列执行，不能重入尚未完成的状态转换。
        DispatchQueue.main.async { observer(event) }
    }

    /// 同步返回占位页面，便于先 push；onReady 只在通信就绪且业务子树成功提交后触发，不代表初始化已同步完成。
    @discardableResult public func open(
        featureId: String, params: [String: Any] = [:], page: URNPageConfiguration = .init(),
        onReady: @escaping (URNPageHandle, Result<Void, Error>) -> Void = { _, _ in },
        onResult: ((URNPageResult) -> Void)? = nil
    ) throws -> URNPageHandle {
        try configuration.validate()
        guard !stoppingRuntime, reloadCompletion == nil,
            state == .idle || state == .starting || state == .running
        else { throw URNContainerError("RUNTIME_UNAVAILABLE", "运行时重载、关闭或故障中，不能打开新页面") }
        guard featureId.utf8.count <= 80,
            featureId.range(of: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$", options: .regularExpression)
                != nil
        else { throw URNContainerError("INVALID_FEATURE", "业务标识必须为 1 至 80 位合法字符") }
        guard records.count < min(64, max(1, configuration.maxPages)) else {
            throw URNContainerError("PAGE_LIMIT", "页面达到容器预算，尚未完成清理的页面仍占用名额")
        }
        guard JSONSerialization.isValidJSONObject(params) else {
            throw URNContainerError("INVALID_PARAMS", "页面参数必须是 JSON 对象")
        }
        // 固定参数快照，避免调用方后续修改 NSMutableDictionary 影响重载后的页面。
        let data = try JSONSerialization.data(withJSONObject: params)
        guard data.count <= 256 * 1024,
            let snapshot = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw URNContainerError("INVALID_PARAMS", "页面参数超过预算") }
        let handle = URNPageHandle(id: UUID().uuidString, featureId: featureId)
        handle.coordinator = self
        let record = Record(handle: handle, params: snapshot, configuration: page, onReady: onReady)
        record.onResult = onResult
        handle.lifecycle.foreground = UIApplication.shared.applicationState != .background
        records[handle.id] = record
        handle.controller.showOverlay(configuration.pageUI.loading(handle))
        handle.controller.onVisibility = { [weak self, weak handle] visible in
            guard let self, let handle, let record = self.records[handle.id] else { return }
            guard handle.lifecycle.visible != visible, !handle.lifecycle.closed else { return }
            handle.lifecycle.visible = visible
            self.publishLifecycle(record)
        }
        handle.controller.onAttachment = { [weak self, weak handle] in
            guard let self, let handle, let record = self.records[handle.id], record.openCancelled
            else { return }
            self.cancelNavigation(record)
        }
        diagnostic("page.opening", record: record)
        handle.controller.onNavigationDismissed = { [weak self] navigation in
            guard let self else { return }
            for record in Array(self.records.values)
            where record.handle.controller.navigationController === navigation {
                self.close(record.handle)
            }
        }
        handle.controller.onRemoved = { [weak self, weak handle] in
            guard let self, let handle else { return }
            self.close(handle)
        }
        if state == .idle { startRuntime() }
        if let runtime, let generation = runtime.generation, router != nil {
            mount(record, runtime: runtime, generation: generation)
        }
        return handle
    }

    public func close(
        _ handle: URNPageHandle, completion: @escaping (Result<Void, Error>) -> Void = { _ in }
    ) {
        guard let record = records[handle.id], record.handle === handle else {
            completion(.success(()))
            return
        }
        record.closedByOwner = true
        if let error = record.closeFailure {
            completion(.failure(error))
            return
        }
        record.closeCallbacks.append(completion)
        beginClosing(record)
    }

    /// 原生导航的呈现方拥有 dismiss：完成后通知本方法，包含被普通原生页覆盖的 RN 页面。
    /// 单页 pop 可自动关闭；任意外部容器被销毁时，宿主仍需提供明确的生命周期通知。
    public func closePages(
        in navigation: UINavigationController,
        completion: @escaping (Result<Void, Error>) -> Void = { _ in }
    ) {
        let pages = records.values.filter {
            $0.handle.controller.navigationController === navigation
        }
        guard !pages.isEmpty else {
            completion(.success(()))
            return
        }
        var pending = pages.count
        var firstError: Error?
        for record in pages {
            close(record.handle) { result in
                if case .failure(let error) = result, firstError == nil { firstError = error }
                pending -= 1
                if pending == 0 { completion(firstError.map { .failure($0) } ?? .success(())) }
            }
        }
    }

    public func closeAll(completion: @escaping (Result<Void, Error>) -> Void = { _ in }) {
        // 尚未确认启动的运行时可能已无页面记录；重复关闭必须返回同一个已知故障。
        if records.isEmpty, runtime != nil, !bundleBooted, let error = runtimeFailure {
            state = .failed
            completion(.failure(error))
            return
        }
        shutdownCompletions.append(completion)
        state = .stopping
        if let reloadCompletion {
            self.reloadCompletion = nil
            reloadCompletion(.failure(URNContainerError("CANCELLED", "完整关闭取消了 Reload")))
        }
        state = .stopping
        for record in Array(records.values) {
            record.closedByOwner = true
            beginClosing(record)
        }
        if let error = records.values.compactMap({ $0.closeFailure }).first {
            state = .failed
            reportRuntimeFailure(error)
        }
        advance()
    }

    public func reload(completion: @escaping (Result<Void, Error>) -> Void = { _ in }) {
        guard state == .running || state == .starting, reloadCompletion == nil else {
            completion(.failure(URNContainerError("RUNTIME_UNAVAILABLE", "当前状态不能 Reload")))
            return
        }
        guard
            !records.values.contains(where: {
                $0.openPending || $0.navigationClosing || $0.navigationRecoveryFailed
            })
        else {
            completion(.failure(URNContainerError("NAVIGATION_BUSY", "请先完成或恢复导航关闭，再执行Reload")))
            return
        }
        // Reload复用Record，因此独立轮换导航epoch，不能只比较Record身份。
        for record in records.values {
            record.navigationEpoch = UUID()
            record.navigationOpenWork?.cancel()
            record.navigationCloseWork?.cancel()
            record.navigationCloseID = nil
        }
        state = .reloading
        reloadCompletion = completion
        for record in Array(records.values) { beginClosing(record) }
        advance()
    }

    private func startRuntime() {
        state = .starting
        runtimeStartedAt = ProcessInfo.processInfo.systemUptime
        runtimeFailure = nil
        guard
            let runtime = URNReactHost(
                bundleURL: configuration.bundleURL,
                dependencyProvider: configuration.dependencyProvider,
                channelBudget: configuration.effectiveChannelBudget.mapValues {
                    NSNumber(value: $0)
                })
        else {
            let error = URNContainerError("INVALID_BUDGET", "原生运行时拒绝预算配置")
            reportRuntimeFailure(error)
            for record in Array(records.values) { fail(record, error) }
            return
        }
        self.runtime = runtime
        diagnostic("runtime.starting")
        runtimeInitialized = false
        bundleBooted = false
        runtime.onBooted = { [weak self, weak runtime] in
            guard let self, self.runtime === runtime else { return }
            self.bundleBooted = true
            self.bootWork?.cancel()
            self.diagnostic("runtime.booted", startedAt: self.runtimeStartedAt)
            self.advance()
        }
        runtime.onInitialized = { [weak self, weak runtime] generation in
            guard let self, let runtime, self.runtime === runtime else { return }
            self.runtimeInitialized = true
            self.diagnostic("runtime.initialized", startedAt: self.runtimeStartedAt)
            if self.state == .reloading || self.state == .stopping {
                self.advance()
                return
            }
            self.router = URNChannelRouter(
                engine: self.configuration.engine, generation: generation,
                maxPages: self.configuration.maxPages,
                maxRetiredChannels: self.configuration.channelBudget.maxRetiredChannels
            ) { [weak runtime] address, text in runtime?.emitMessage(text, channel: address.channel)
            }
            self.state = .running
            for record in Array(self.records.values) where !record.closing {
                self.mount(record, runtime: runtime, generation: generation)
            }
            if self.records.isEmpty { self.advance() }
        }
        runtime.onCommand = { [weak self, weak runtime] channel, command, id, payload in
            guard let self, self.runtime === runtime else { return }
            self.pageCommand(channel: channel, command: command, id: id, payload: payload)
        }
        runtime.onMessage = { [weak self, weak runtime] generation, channel, message in
            guard let self, self.runtime === runtime else { return }
            self.router?.receive(
                URNAddress(generation: generation, channel: channel), message: message)
        }
        runtime.onLifecycle = { [weak self, weak runtime] channel, event, code, message in
            guard let self, let runtime, self.runtime === runtime else { return }
            self.lifecycle(channel: channel, event: event, code: code, message: message)
        }
        runtime.onFault = { [weak self, weak runtime] channel, code, message in
            guard let self, self.runtime === runtime else { return }
            let error = URNContainerError(code, message)
            self.diagnostic(
                channel == nil ? "runtime.failed" : "channel.failed",
                record: channel.flatMap { self.record(channel: $0) },
                code: code == "BACKPRESSURE" ? "BACKPRESSURE" : "RUNTIME_DISCONNECTED")
            self.configuration.onDiagnostic(code, message)
            if let channel, let record = self.record(channel: channel) {
                self.fail(record, error)
            } else {
                self.state = .failed
                self.runtimeFailure = error
                for record in Array(self.records.values) { self.fail(record, error) }
            }
        }
        runtime.onReloadRequested = { [weak self, weak runtime] in
            guard let self, self.runtime === runtime else { return }
            self.reload()
        }
        let boot = DispatchWorkItem { [weak self, weak runtime] in
            guard let self, self.runtime === runtime, !self.bundleBooted else { return }
            self.state = .failed
            let error = URNContainerError("RUNTIME_START_TIMEOUT", "RN bundle 尚未确认启动，不能假报运行时已安全释放")
            self.configuration.onDiagnostic(error.code, error.message)
            for record in Array(self.records.values) { self.fail(record, error) }
            self.reportRuntimeFailure(error)
        }
        bootWork = boot
        DispatchQueue.main.asyncAfter(
            deadline: .now() + max(1, configuration.startupTimeout), execute: boot)
        runtime.start()
    }

    private func mount(_ record: Record, runtime: URNReactHost, generation: String) {
        guard records[record.handle.id] === record, !record.closing, record.address == nil else {
            return
        }
        let channel = UUID().uuidString
        let address = URNAddress(generation: generation, channel: channel)
        record.address = address
        record.handle.channelId = channel
        record.mountAttempt = UUID()
        guard runtime.registerChannel(channel) else {
            fail(record, URNContainerError("CHANNEL_LIMIT", "运行时拒绝通道注册"))
            return
        }
        do {
            try router?.open(
                address,
                uiContext: BridgeUIContext(containerViewController: record.handle.controller),
                allowedPermissions: record.configuration.allowedPermissions,
                allowedEventTopics: record.configuration.allowedEventTopics)
            guard !record.closing, self.runtime === runtime else { return }
            guard
                let root = runtime.root(
                    forFeature: record.handle.featureId, params: record.params,
                    pageId: record.handle.id, channel: channel, baseline: configuration.baselineId)
            else { throw URNContainerError("ROOT_UNAVAILABLE", "无法创建 RN 根视图") }
            record.handle.controller.install(root)
            diagnostic("page.rootCreated", record: record, startedAt: record.openedAt)
            let attempt = record.mountAttempt
            let work = DispatchWorkItem { [weak self, weak record] in
                guard let self, let record, record.mountAttempt == attempt, !record.closing,
                    record.handle.state != .ready
                else { return }
                self.fail(record, URNContainerError("STARTUP_TIMEOUT", "RN 页面未在期限内完成握手"))
            }
            record.startupWork = work
            DispatchQueue.main.asyncAfter(
                deadline: .now() + max(1, configuration.startupTimeout), execute: work)
        } catch { fail(record, error) }
    }

    private func record(channel: String) -> Record? {
        records.values.first { $0.address?.channel == channel }
    }

    private func lifecycle(channel: String, event: String, code: String, message: String) {
        guard let record = record(channel: channel) else { return }
        switch event {
        case "mounted":
            if !record.mounted {
                diagnostic("page.mounted", record: record, startedAt: record.openedAt)
            }
            record.mounted = true
        case "startupFailed":
            // 失败组件也在 React effect 中报告，意味着 surface 已真实启动，可以安全卸载。
            record.mounted = true
            fail(record, URNContainerError(code, message))
        case "bridgeReady":
            guard !record.closing, !record.bridgeReady else { break }
            record.bridgeReady = true
            diagnostic("page.bridgeReady", record: record, startedAt: record.openedAt)
        case "ready":
            guard !record.closing, !record.navigationRecoveryFailed, record.bridgeReady,
                record.handle.state != .ready
            else { break }
            record.startupWork?.cancel()
            record.handle.state = .ready
            record.handle.controller.showOverlay(nil)
            publishLifecycle(record)
            diagnostic("page.ready", record: record, startedAt: record.openedAt)
            let callback = record.onReady
            record.onReady = nil
            callback?(record.handle, .success(()))
            configuration.onDiagnostic("PAGE_READY", record.handle.id)
            completeReloadIfReady()
        case "disposed":
            record.disposed = true
            if !record.closing {
                // JS 本地预算/Core 故障也要关闭原生连接；不把 disposed 当作 mounted。
                diagnostic("channel.failed", record: record, code: "CHANNEL_DISCONNECTED")
                fail(record, URNContainerError("CHANNEL_DISCONNECTED", "JS 页面连接已意外关闭"))
            }
        default: return
        }
        advance(record)
        advance()
    }

    private func fail(_ record: Record, _ error: Error) {
        guard records[record.handle.id] === record, !record.closing else { return }
        record.handle.error = error
        diagnostic("page.failed", record: record, code: "PAGE_FAILED", startedAt: record.openedAt)
        let callback = record.onReady
        record.onReady = nil
        // 页面故障保留导航身份；共享 Runtime 故障和 Reload 故障不能局部恢复。
        record.recoverable =
            runtimeFailure == nil && reloadCompletion == nil
            && (state == .running || state == .starting)
        record.closedByOwner = !record.recoverable
        record.handle.canRetry = false
        if reloadCompletion != nil { reportRuntimeFailure(error) }
        beginClosing(record)
        showFailure(record)
        callback?(record.handle, .failure(error))
    }

    private func beginClosing(_ record: Record) {
        guard !record.closing else {
            advance(record)
            return
        }
        record.closing = true
        record.handle.canRetry = false
        record.closeStartedAt = ProcessInfo.processInfo.systemUptime
        record.handle.state = .closing
        diagnostic("page.closing", record: record)
        record.startupWork?.cancel()
        if record.handle.controller.root != nil && !record.mounted {
            let attempt = record.mountAttempt
            let work = DispatchWorkItem { [weak self, weak record] in
                guard let self, let record, record.mountAttempt == attempt, !record.mounted,
                    record.handle.controller.root != nil
                else { return }
                let error = URNContainerError("ROOT_STOP_PENDING", "根视图尚未确认启动，保留资源等待安全卸载")
                record.handle.state = .failed
                record.handle.error = error
                self.state = .failed
                self.configuration.onDiagnostic(error.code, error.message)
                self.reportCloseFailure(record, error)
            }
            record.mountWaitWork = work
            DispatchQueue.main.asyncAfter(
                deadline: .now() + max(1, configuration.startupTimeout), execute: work)
        }
        if let address = record.address {
            router?.beginClosing(address)
            runtime?.requestClose(
                address.channel, reason: state == .reloading ? "reload" : "pageClosed")
            let attempt = record.mountAttempt
            let work = DispatchWorkItem { [weak self, weak record] in
                guard let self, let record, record.mountAttempt == attempt else { return }
                self.closeNative(record)
            }
            record.closeWork = work
            DispatchQueue.main.asyncAfter(
                deadline: .now() + max(0.05, configuration.closeWindow), execute: work)
            if record.disposed { closeNative(record) }
        } else {
            closeNative(record)
        }
    }

    private func closeNative(_ record: Record) {
        guard !record.nativeClosed else { return }
        record.nativeClosed = true
        record.closeWork?.cancel()
        if let address = record.address {
            router?.close(address)  // 保留 Inbox 的通道直到 mounted：早期 disposed 后还可能收到真实空 Root commit。
        }
        diagnostic("page.connectionClosed", record: record)
        let ready = record.onReady
        record.onReady = nil
        ready?(record.handle, .failure(URNContainerError("CANCELLED", "页面在 ready 前关闭")))
        beginCleanup(record)
    }

    public func retryCleanup(
        _ handle: URNPageHandle, completion: @escaping (Result<Void, Error>) -> Void = { _ in }
    ) {
        guard let record = records[handle.id], record.handle === handle, record.nativeClosed,
            !record.cleanupDone, handle.state == .failed
        else {
            completion(.failure(URNContainerError("INVALID_STATE", "当前页面不需要重试清理")))
            return
        }
        record.closedByOwner = true
        record.closeFailure = nil
        record.closeCallbacks.append(completion)
        handle.state = .closing
        record.cleanupWork?.cancel()
        beginCleanup(record)
    }

    private func beginCleanup(_ record: Record) {
        let attempt = UUID()
        record.cleanupStartedAt = ProcessInfo.processInfo.systemUptime
        diagnostic("cleanup.starting", record: record)
        record.cleanupAttempt = attempt
        let work = DispatchWorkItem { [weak self, weak record] in
            guard let self, let record, record.cleanupAttempt == attempt, !record.cleanupDone else {
                return
            }
            let error = URNContainerError("CLEANUP_TIMEOUT", "业务资源尚未完成清理，不能报告容器已释放")
            record.handle.state = .failed
            record.handle.error = error
            self.state = .failed
            self.diagnostic(
                "cleanup.failed", record: record, code: "CLEANUP_TIMEOUT",
                startedAt: record.cleanupStartedAt)
            self.configuration.onDiagnostic(error.code, error.message)
            self.reportCloseFailure(record, error)
        }
        record.cleanupWork = work
        DispatchQueue.main.asyncAfter(
            deadline: .now() + max(0.05, configuration.cleanupTimeout), execute: work)
        record.configuration.cleanup { [weak self, weak record] result in
            guard let self, let record, record.cleanupAttempt == attempt, !record.cleanupDone else {
                return
            }
            switch result {
            case .success:
                record.cleanupDone = true
                record.cleanupWork?.cancel()
                self.diagnostic(
                    "cleanup.completed", record: record, startedAt: record.cleanupStartedAt)
                self.advance(record)
                self.advance()
            case .failure(let error):
                record.cleanupAttempt = UUID()
                record.cleanupWork?.cancel()
                record.handle.error = error
                record.handle.state = .failed
                self.state = .failed
                self.diagnostic(
                    "cleanup.failed", record: record, code: "CLEANUP_FAILED",
                    startedAt: record.cleanupStartedAt)
                self.reportCloseFailure(record, error)
            }
        }
        advance(record)
        advance()
    }

    private func reportCloseFailure(_ record: Record, _ error: Error) {
        record.closeFailure = error
        let callbacks = record.closeCallbacks
        record.closeCallbacks.removeAll()
        callbacks.forEach { $0(.failure(error)) }
        reportRuntimeFailure(error)
    }

    private func reportRuntimeFailure(_ error: Error) {
        runtimeFailure = error
        let shutdown = shutdownCompletions
        shutdownCompletions.removeAll()
        let reload = reloadCompletion
        reloadCompletion = nil
        if reload != nil {
            // 完整重载失败后不留下半恢复运行时；保留失败清理记录，供宿主明确重试释放。
            state = .failed
            for record in Array(records.values) {
                record.closedByOwner = true
                beginClosing(record)
            }
        }
        shutdown.forEach { $0(.failure(error)) }
        reload?(.failure(error))
    }

    private func advance(_ record: Record) {
        // 同步 cleanup 与外层推进可能再次到达这里；已移除的记录不能再次完成关闭。
        guard records[record.handle.id] === record else { return }
        if record.closing && record.disposed { closeNative(record) }
        // closeNative 可能同步清理并在重入中移除记录，返回后再次确认所有权。
        guard records[record.handle.id] === record, record.closing, record.nativeClosed,
            record.cleanupDone
        else { return }
        guard record.handle.controller.root == nil || record.mounted else { return }
        if let root = record.handle.controller.removeRoot() { runtime?.detachRoot(root) }
        if let address = record.address { runtime?.retireChannel(address.channel) }
        let retiredAddress = record.address
        record.address = nil
        record.closeWork?.cancel()
        record.cleanupWork?.cancel()
        record.mountWaitWork?.cancel()
        if record.recoverable && !record.closedByOwner {
            record.handle.state = .failed
            record.handle.canRetry =
                runtimeFailure == nil && state == .running && !record.openPending
                && !record.openCancelled && !record.navigationClosing
                && !record.navigationRecoveryFailed
            showFailure(record)
            return
        }
        if record.closedByOwner {
            records.removeValue(forKey: record.handle.id)
            if records.isEmpty && state != .reloading { state = .stopping }
            record.navigationOpenWork?.cancel()
            record.navigationCloseWork?.cancel()
            record.navigationCloseID = nil
            record.handle.canRetryNavigationClose = false
            record.handle.controller.rejectsLateAttachment = true
            record.handle.state = .closed
            record.handle.lifecycle.closed = true
            record.handle.lifecycle.visible = false
            record.handle.canRetry = false
            let resultCallback = record.onResult
            record.onResult = nil
            resultCallback?(record.result)
            diagnostic(
                "page.closed", record: record, startedAt: record.closeStartedAt,
                channelId: retiredAddress?.channel)
            let callbacks = record.closeCallbacks
            record.closeCallbacks.removeAll()
            callbacks.forEach { $0(.success(())) }
        }
    }

    private func advance() {
        for record in Array(records.values) { advance(record) }
        completeReloadIfReady()
        // 故障页面已显式重试并释放后，允许仍健康的同轮页面继续接入新页面。
        // Reload 失败会封闭全部页面，因此不会走这条局部恢复路径。
        if state == .failed, runtimeInitialized, bundleBooted, !stoppingRuntime,
            reloadCompletion == nil, !records.isEmpty,
            records.values.allSatisfy({ !$0.closing && $0.handle.state == .ready })
        {
            state = .running
            runtimeFailure = nil
        }
        let resetting = state == .reloading || state == .stopping
        let noPendingRoots = records.values.allSatisfy {
            $0.closing && $0.cleanupDone && $0.address == nil
        }
        guard records.isEmpty || (resetting && noPendingRoots) else { return }
        guard !stoppingRuntime else { return }
        guard let runtime else {
            finishRuntimeStop(.success(()))
            return
        }
        // 启动中关闭也等真实 Runtime token，不能捏造第 0 轮作为释放依据。
        guard runtimeInitialized, bundleBooted else { return }
        stoppingRuntime = true
        runtimeStopStartedAt = ProcessInfo.processInfo.systemUptime
        diagnostic("runtime.stopping")
        router?.closeAll()
        router = nil
        runtime.stop { [weak self, weak runtime] error in
            guard let self, self.runtime === runtime else { return }
            self.finishRuntimeStop(error.map { .failure($0) } ?? .success(()))
        }
    }

    private func completeReloadIfReady() {
        guard state == .running, records.values.allSatisfy({ $0.handle.state == .ready }),
            let completion = reloadCompletion
        else { return }
        reloadCompletion = nil
        completion(.success(()))
    }

    private func finishRuntimeStop(_ result: Result<Void, Error>) {
        stoppingRuntime = false
        switch result {
        case .failure(let error):
            state = .failed
            diagnostic(
                "runtime.failed", code: "RUNTIME_RELEASE_FAILED", startedAt: runtimeStopStartedAt)
            configuration.onDiagnostic("RUNTIME_RELEASE_FAILED", error.localizedDescription)
            let reload = reloadCompletion
            reloadCompletion = nil
            reload?(.failure(error))
        case .success:
            diagnostic("runtime.stopped", startedAt: runtimeStopStartedAt)
            bootWork?.cancel()
            runtimeFailure = nil
            runtime = nil
            router = nil
            let shouldRestart = state == .reloading && !records.isEmpty
            state = .idle
            if shouldRestart {
                for record in records.values {
                    record.closing = false
                    record.nativeClosed = false
                    record.cleanupDone = false
                    record.disposed = false
                    record.bridgeReady = false
                    record.mounted = false
                    record.openedAt = ProcessInfo.processInfo.systemUptime
                    record.handle.state = .starting
                    record.recoverable = false
                    record.handle.error = nil
                    record.handle.canRetry = false
                    record.handle.controller.showOverlay(
                        configuration.pageUI.loading(record.handle))
                }
                startRuntime()
                return
            }
            let reload = reloadCompletion
            reloadCompletion = nil
            reload?(.success(()))
        }
        let callbacks = shutdownCompletions
        shutdownCompletions.removeAll()
        callbacks.forEach { $0(result) }
    }
    private func showFailure(_ record: Record) {
        guard let error = record.handle.error else { return }
        let handle = record.handle
        handle.controller.showOverlay(
            configuration.pageUI.failure(handle, error, handle.canRetry) { [weak handle] in
                handle?.retry()
            })
    }

    /// 单页恢复复用 Handle，旧连接和业务资源完成清理后再分配新 channel。
    public func retry(
        _ handle: URNPageHandle, completion: @escaping (Result<Void, Error>) -> Void = { _ in }
    ) {
        guard let old = records[handle.id], old.handle === handle, handle.canRetry, old.recoverable,
            old.cleanupDone, old.address == nil, !old.openPending, !old.navigationClosing,
            state == .running, runtimeFailure == nil, let runtime,
            let generation = runtime.generation
        else {
            completion(.failure(URNContainerError("RETRY_UNAVAILABLE", "页面仍在清理或运行时不可恢复")))
            return
        }
        handle.canRetry = false
        handle.error = nil
        handle.state = .starting
        let record = Record(handle: handle, params: old.params, configuration: old.configuration) {
            _, result in completion(result)
        }
        record.onResult = old.onResult
        old.onResult = nil
        record.result = old.result
        record.originAddress = old.originAddress
        record.originRequestId = old.originRequestId
        record.lifecycleSeq = old.lifecycleSeq
        records[handle.id] = record
        handle.controller.showOverlay(configuration.pageUI.loading(handle))
        diagnostic("page.retrying", record: record)
        mount(record, runtime: runtime, generation: generation)
    }

    private func publishLifecycle(_ record: Record) {
        guard let address = record.address, !record.closing else { return }
        record.lifecycleSeq += 1
        emitPageEvent(
            address,
            [
                "type": "lifecycle", "seq": record.lifecycleSeq,
                "visible": record.handle.lifecycle.visible,
                "foreground": record.handle.lifecycle.foreground,
            ])
    }

    private func emitPageEvent(_ address: URNAddress, _ event: [String: Any]) {
        guard runtime?.generation == address.generation,
            record(channel: address.channel)?.closing == false,
            let data = try? JSONSerialization.data(withJSONObject: event), data.count <= 32768,
            let message = String(data: data, encoding: .utf8)
        else { return }
        runtime?.emitPageEvent(message, channel: address.channel)
    }

    private func pageCommand(channel: String, command: String, id: String, payload: String) {
        guard let source = record(channel: channel), !source.closing, let address = source.address
        else { return }
        do {
            guard let data = payload.data(using: .utf8), data.count <= 16384,
                let value = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { throw URNContainerError("INVALID_NAVIGATION", "导航参数不合法") }
            switch command {
            case "open":
                guard !source.navigationRecoveryFailed, !source.openCancelled else {
                    throw URNContainerError("NAVIGATION_RECOVERY_REQUIRED", "当前页面正在等待导航恢复关闭")
                }
                guard !id.isEmpty, source.navigationPending < 16,
                    let feature = value["featureId"] as? String,
                    let params = value["params"] as? [String: Any],
                    let raw = value["presentation"] as? String,
                    let presentation = URNPagePresentation(rawValue: raw),
                    source.handle.lifecycle.visible, source.handle.lifecycle.foreground
                else { throw URNContainerError("NAVIGATION_UNAVAILABLE", "发起页面不可见、参数错误或等待结果过多") }
                let pageConfiguration = try configuration.navigationPageConfiguration(
                    source.handle, feature)
                source.navigationPending += 1
                let target: URNPageHandle
                do {
                    target = try open(
                        featureId: feature, params: params, page: pageConfiguration,
                        onResult: { [weak self, weak source] result in
                            source?.navigationPending -= 1
                            self?.emitPageEvent(
                                address, ["type": "result", "id": id, "result": result.json])
                        })
                } catch {
                    source.navigationPending -= 1
                    throw error
                }
                guard let targetRecord = records[target.id] else { return }
                targetRecord.originAddress = address
                targetRecord.originRequestId = id
                targetRecord.openPending = true
                let navigationEpoch = targetRecord.navigationEpoch
                let deadline = DispatchWorkItem { [weak self, weak targetRecord] in
                    guard let self, let targetRecord, targetRecord.openPending,
                        targetRecord.navigationEpoch == navigationEpoch
                    else { return }
                    targetRecord.openPending = false
                    targetRecord.openCancelled = true
                    self.rejectNavigationOpen(
                        targetRecord,
                        error: URNContainerError("NAVIGATION_TIMEOUT", "宿主未在期限内确认打开页面"))
                    self.cancelNavigation(targetRecord)
                }
                targetRecord.navigationOpenWork = deadline
                DispatchQueue.main.asyncAfter(
                    deadline: .now() + configuration.navigationTimeout, execute: deadline)
                configuration.navigator.open(
                    target, from: source.handle.controller, presentation: presentation
                ) { [weak self, targetRecord] result in
                    guard let self, targetRecord.navigationEpoch == navigationEpoch else { return }
                    // 单页重试复用Handle/Controller；旧Record的回调不能撤销新Record的页面。
                    if let owner = self.records[target.id], owner !== targetRecord { return }
                    guard targetRecord.openPending else {
                        if targetRecord.openCancelled || self.records[target.id] !== targetRecord {
                            self.cancelNavigation(
                                targetRecord, detached: self.records[target.id] !== targetRecord)
                        }
                        return
                    }
                    targetRecord.navigationOpenWork?.cancel()
                    targetRecord.openPending = false
                    guard self.records[target.id] === targetRecord else {
                        targetRecord.navigationClosing = false
                        self.cancelNavigation(targetRecord, detached: true)
                        return
                    }
                    switch result {
                    case .success:
                        if targetRecord.openCancelled {
                            self.cancelNavigation(targetRecord)
                        } else {
                            self.advance(targetRecord)
                            self.emitPageEvent(
                                address, ["type": "opened", "id": id, "pageId": target.id])
                        }
                    case .failure(let error):
                        targetRecord.openCancelled = true
                        self.rejectNavigationOpen(targetRecord, error: error)
                        self.cancelNavigation(targetRecord)
                    }
                }
            case "cancelOpen":
                guard
                    let target = records.values.first(where: {
                        $0.originAddress == address && $0.originRequestId == id
                    })
                else { return }
                target.navigationOpenWork?.cancel()
                target.openPending = false
                target.openCancelled = true
                rejectNavigationOpen(
                    target, error: URNContainerError("NAVIGATION_CANCELLED", "调用方已取消打开页面"))
                cancelNavigation(target)
            case "close":
                guard id.isEmpty else { throw URNContainerError("INVALID_NAVIGATION", "关闭不携带请求ID") }
                if let result = value["data"], !(result is [String: Any]) {
                    throw URNContainerError("INVALID_NAVIGATION", "返回值必须是JSON对象")
                }
                finish(source.handle, result: value["data"] as? [String: Any])
            default: throw URNContainerError("INVALID_NAVIGATION", "未知导航命令")
            }
        } catch { navigationError(address, id: id, error: error) }
    }

    private func rejectNavigationOpen(_ record: Record, error: Error) {
        guard record.onResult != nil else { return }
        record.onResult = nil
        if let address = record.originAddress, let source = self.record(channel: address.channel),
            source.address == address
        {
            source.navigationPending = max(0, source.navigationPending - 1)
        }
        if let address = record.originAddress, let id = record.originRequestId {
            navigationError(address, id: id, error: error)
        }
    }

    public func retryNavigationClose(_ handle: URNPageHandle) {
        guard let record = records[handle.id], record.handle === handle,
            handle.canRetryNavigationClose
        else { return }
        record.result = .cancelled
        cancelNavigation(record)
    }

    private func cancelNavigation(_ record: Record, detached: Bool = false) {
        if let owner = records[record.handle.id], owner !== record { return }
        guard (records[record.handle.id] === record || detached), !record.navigationClosing else {
            return
        }
        record.navigationClosing = true
        record.handle.canRetryNavigationClose = false
        record.handle.navigationError = nil
        let identity = UUID()
        record.navigationCloseID = identity
        let timeout = DispatchWorkItem { [weak self, weak record] in
            guard let self, let record, record.navigationCloseID == identity else { return }
            if !record.handle.controller.isAttachedToHost {
                self.completeNavigationClose(record)
            } else {
                self.navigationCloseFailed(
                    record, URNContainerError("NAVIGATION_CLOSE_TIMEOUT", "宿主未在期限内完成页面移除"))
            }
        }
        record.navigationCloseWork = timeout
        DispatchQueue.main.asyncAfter(
            deadline: .now() + configuration.navigationTimeout, execute: timeout)
        attemptNavigationClose(record, identity: identity)
    }

    private func attemptNavigationClose(_ record: Record, identity: UUID) {
        guard record.navigationCloseID == identity else { return }
        if !record.handle.controller.isAttachedToHost {
            completeNavigationClose(record)
            return
        }
        if record.handle.controller.transitionCoordinator != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self, weak record] in
                guard let record else { return }
                self?.attemptNavigationClose(record, identity: identity)
            }
            return
        }
        var completed = false
        configuration.navigator.close(record.handle) { [weak self, weak record] response in
            guard let self, let record, record.navigationCloseID == identity, !completed else {
                return
            }
            completed = true
            switch response {
            case .success:
                if !record.handle.controller.isAttachedToHost {
                    self.completeNavigationClose(record)
                } else {
                    self.navigationCloseFailed(
                        record, URNContainerError("NAVIGATION_NOT_REMOVED", "宿主报告成功但页面仍挂载"))
                }
            case .failure(let error):
                if (error as? URNContainerError)?.code == "NAVIGATION_BUSY" {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                        [weak self, weak record] in
                        guard let record else { return }
                        self?.attemptNavigationClose(record, identity: identity)
                    }
                } else {
                    self.navigationCloseFailed(record, error)
                }
            }
        }
    }

    private func completeNavigationClose(_ record: Record) {
        if let owner = records[record.handle.id], owner !== record { return }
        record.navigationCloseWork?.cancel()
        record.navigationCloseID = nil
        record.navigationClosing = false
        record.handle.canRetryNavigationClose = false
        record.handle.navigationError = nil
        record.handle.controller.rejectsLateAttachment = true
        close(record.handle)
    }

    private func navigationCloseFailed(_ record: Record, _ error: Error) {
        record.navigationCloseWork?.cancel()
        record.navigationCloseID = nil
        record.navigationClosing = false
        record.result = .cancelled
        record.navigationRecoveryFailed = true
        record.startupWork?.cancel()
        record.handle.canRetry = false
        let ready = record.onReady
        record.onReady = nil
        ready?(record.handle, .failure(error))
        record.handle.navigationError = error
        if let address = record.address { navigationError(address, id: "", error: error) }
        record.handle.canRetryNavigationClose = records[record.handle.id] === record
        if let address = record.address { router?.beginClosing(address) }
        diagnostic(
            "navigation.closeFailed", record: record,
            code: (error as? URNContainerError)?.code ?? "NAVIGATION_FAILED")
        configuration.onDiagnostic("NAVIGATION_CANCEL_FAILED", "页面仍保留，请恢复宿主导航后重试关闭")
        if records[record.handle.id] === record {
            let button = UIButton(type: .system)
            button.setTitle("重试关闭", for: .normal)
            button.addAction(
                UIAction { [weak record] _ in record?.handle.retryNavigationClose() },
                for: .touchUpInside)
            record.handle.controller.showOverlay(
                URNPageUI.container([URNPageUI.label("页面关闭失败"), button], id: "urn.navigationError"))
        }
    }

    private func navigationError(_ address: URNAddress, id: String, error: Error) {
        let code = (error as? URNContainerError)?.code ?? "NAVIGATION_FAILED"
        configuration.onDiagnostic(code, "页面导航失败")
        emitPageEvent(address, ["type": "error", "id": id, "code": code])
    }

    public func finish(_ handle: URNPageHandle, result: [String: Any]? = nil) {
        guard let record = records[handle.id], record.handle === handle,
            (!record.closing || (record.recoverable && !record.closedByOwner)),
            !record.navigationClosing
        else { return }
        if let result {
            guard JSONSerialization.isValidJSONObject(result),
                let data = try? JSONSerialization.data(withJSONObject: result), data.count <= 16384
            else {
                if let address = record.address {
                    navigationError(
                        address, id: "",
                        error: URNContainerError("INVALID_NAVIGATION", "返回值不是合法JSON"))
                }
                return
            }
        }
        let snapshot = result.flatMap { value -> [String: Any]? in
            guard let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
            return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        }
        record.result = .completed(snapshot)
        cancelNavigation(record)
    }

}
