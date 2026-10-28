import UIKit

@MainActor public final class URNPageHandle {
    public enum State: String, Sendable { case starting, ready, closing, closed, failed }
    public let id: String
    public let featureId: String
    public var viewController: UIViewController { controller }
    public internal(set) var state: State = .starting
    public internal(set) var error: Error?
    public internal(set) var lifecycle = URNPageLifecycle()
    public internal(set) var channelId: String?
    public internal(set) var canRetry = false
    public internal(set) var navigationError: Error?
    public internal(set) var canRetryNavigationClose = false

    /// 关闭转场超时或失败后，由宿主恢复导航能力再显式重试；不重新启动业务。
    public func retryNavigationClose() { coordinator?.retryNavigationClose(self) }

    public func retry(completion: @escaping (Result<Void, Error>) -> Void = { _ in }) {
        guard let coordinator else {
            completion(.failure(URNContainerError("DISCONNECTED", "容器已释放")))
            return
        }
        coordinator.retry(self, completion: completion)
    }

    /// 导航移除和资源清理完成后才返回结果；直接 close() 仍只负责资源清理。
    public func finish(result: [String: Any]? = nil) { coordinator?.finish(self, result: result) }
    let controller = URNViewController()
    weak var coordinator: URNCoordinator?

    init(id: String, featureId: String) {
        self.id = id
        self.featureId = featureId
    }

    /// 仅关闭容器资源；宿主自行决定 pop/dismiss，确认原生移除也会触发同一清理。
    public func close(completion: @escaping (Result<Void, Error>) -> Void = { _ in }) {
        guard let coordinator else {
            completion(.success(()))
            return
        }
        coordinator.close(self, completion: completion)
    }
}

/// 页面被覆盖、切后台、React effect cleanup 都不意味着原生页面退出。
@MainActor final class URNViewController: UIViewController {
    var onAttachment: (() -> Void)?
    var rejectsLateAttachment = false
    private var rejectingAttachment = false
    var onVisibility: ((Bool) -> Void)?
    private var overlay: UIView?
    var onRemoved: (() -> Void)?
    var onNavigationDismissed: ((UINavigationController) -> Void)?
    private var wasAttached = false
    private weak var dismissedNavigation: UINavigationController?
    private(set) var root: UIView?

    override func loadView() {
        let content = UIView()
        content.backgroundColor = .systemBackground
        view = content
    }

    func showOverlay(_ content: UIView?) {
        loadViewIfNeeded()
        overlay?.removeFromSuperview()
        overlay = content
        if let content {
            content.frame = view.bounds
            content.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.addSubview(content)
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        onAttachment?()
        rejectLateAttachmentIfNeeded()
        onVisibility?(true)
    }

    func install(_ root: UIView) {
        loadViewIfNeeded()
        self.root = root
        root.frame = view.bounds
        root.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.insertSubview(root, at: 0)
    }

    func removeRoot() -> UIView? {
        let old = root
        root = nil
        old?.removeFromSuperview()
        return old
    }

    override func didMove(toParent parent: UIViewController?) {
        super.didMove(toParent: parent)
        if parent != nil {
            wasAttached = true
            onAttachment?()
            rejectLateAttachmentIfNeeded()
        } else if wasAttached {
            // UIKit 仅在确认 pop 后移除 parent；取消交互转场不会走此分支。
            // 确认移除后立即封闭页面；额外延后一轮会让快速 Reload 把已 pop 的页面重建。
            onRemoved?()
        }
    }

    /// 模态导航的根页在 dismiss 后仍有 parent，必须检查最外层容器的呈现/窗口关系。
    var isAttachedToHost: Bool {
        var owner: UIViewController = self
        while let parent = owner.parent { owner = parent }
        return owner.presentingViewController != nil || owner.viewIfLoaded?.window != nil
            || transitionCoordinator != nil
    }

    /// 关闭后的 controller 不允许被迟到的宿主导航重新挂载；不重新创建连接或业务对象。
    private func rejectLateAttachmentIfNeeded() {
        guard rejectsLateAttachment, !rejectingAttachment else { return }
        rejectingAttachment = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.rejectingAttachment = false
            guard self.rejectsLateAttachment else { return }
            if let transition = self.transitionCoordinator {
                transition.animate(alongsideTransition: nil) { [weak self] _ in
                    self?.rejectLateAttachmentIfNeeded()
                }
                return
            }
            if let navigation = self.navigationController {
                if navigation.viewControllers.count > 1 {
                    navigation.setViewControllers(
                        navigation.viewControllers.filter { $0 !== self }, animated: false)
                } else if navigation.presentingViewController != nil {
                    navigation.dismiss(animated: false)
                }
            } else if self.presentingViewController != nil {
                self.dismiss(animated: false)
            }
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        guard let navigation = navigationController, navigation.isBeingDismissed else { return }
        if let transitionCoordinator {
            transitionCoordinator.animate(alongsideTransition: nil) {
                [weak self, weak navigation] context in
                guard !context.isCancelled, let navigation else { return }
                self?.onNavigationDismissed?(navigation)
            }
        } else {
            // 无动画时也等 didDisappear，不能在 willDisappear 中提前释放原生页面。
            dismissedNavigation = navigation
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        onVisibility?(false)
        if let navigation = dismissedNavigation {
            dismissedNavigation = nil
            onNavigationDismissed?(navigation)
        }
        guard isBeingDismissed || navigationController?.isBeingDismissed == true else { return }
        if let transitionCoordinator {
            transitionCoordinator.animate(alongsideTransition: nil) { [weak self] context in
                guard !context.isCancelled else { return }
                self?.onRemoved?()
            }
        } else {
            onRemoved?()
        }
    }
}
