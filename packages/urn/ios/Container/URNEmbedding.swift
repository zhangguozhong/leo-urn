import UIKit

/// 宿主持有此owner直到detach成功；失败仍保留child与显式retryCleanup入口。
@MainActor public final class URNEmbeddedPage {
    public let page: URNPageHandle
    public var ownsBack = false
    private weak var parent: UIViewController?
    private weak var container: UIView?
    private var detaching = false
    public private(set) var error: Error?
    public init(
        page: URNPageHandle, parent: UIViewController, container: UIView, frame: CGRect? = nil
    ) throws {
        guard (page.state == .starting || page.state == .ready), page.viewController.parent == nil
        else { throw URNContainerError("PAGE_OWNED", "页面已挂载或关闭") }
        parent.loadViewIfNeeded()
        let geometry = frame ?? container.bounds
        guard container.isDescendant(of: parent.view), Self.valid(geometry) else {
            throw URNContainerError("INVALID_EMBEDDING", "区域必须属于parent.view且几何有限非负")
        }
        self.page = page
        self.parent = parent
        self.container = container
        parent.addChild(page.viewController)
        page.viewController.view.frame = geometry
        page.viewController.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(page.viewController.view)
        page.viewController.didMove(toParent: parent)
    }
    private static func valid(_ frame: CGRect) -> Bool {
        [frame.origin.x, frame.origin.y, frame.size.width, frame.size.height].allSatisfy {
            $0.isFinite && $0 >= 0
        }
    }
    public func resize(_ frame: CGRect) throws {
        guard Self.valid(frame) else { throw URNContainerError("INVALID_EMBEDDING", "尺寸必须有限非负") }
        guard !detaching else { throw URNContainerError("CLEANUP_BUSY", "页面正在清理") }
        page.viewController.view.frame = frame
    }
    public func setVisible(_ visible: Bool) {
        page.viewController.beginAppearanceTransition(visible, animated: false)
        page.viewController.view.isHidden = !visible
        page.viewController.endAppearanceTransition()
    }
    @discardableResult public func handleBack() -> Bool {
        guard ownsBack, !detaching else { return false }
        detach()
        return true
    }
    public func detach(completion: @escaping (Result<Void, Error>) -> Void = { _ in }) {
        guard !detaching else {
            completion(.failure(URNContainerError("CLEANUP_BUSY", "正在等待页面清理")))
            return
        }
        detaching = true
        let finish: (Result<Void, Error>) -> Void = { [self] result in
            detaching = false
            switch result {
            case .failure(let failure): error = failure
            case .success:
                error = nil
                page.viewController.willMove(toParent: nil)
                page.viewController.view.removeFromSuperview()
                page.viewController.removeFromParent()
                parent = nil
                container = nil
            }
            completion(result)
        }
        if error != nil && page.canRetryCleanup {
            page.retryCleanup(completion: finish)
        } else {
            page.close(completion: finish)
        }
    }
}
