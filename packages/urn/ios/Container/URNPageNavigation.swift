import UIKit

public enum URNPagePresentation: String { case push, present }

/// 自定义导航在 UIKit 转场完成后调用 completion；失败或手势取消不能报告成功。
@MainActor public protocol URNPageNavigating: AnyObject {
    func open(
        _ page: URNPageHandle, from source: UIViewController, presentation: URNPagePresentation,
        completion: @escaping (Result<Void, Error>) -> Void)
    func close(_ page: URNPageHandle, completion: @escaping (Result<Void, Error>) -> Void)
}

@MainActor public final class URNUIKitNavigator: URNPageNavigating {
    public init() {}

    public func open(
        _ page: URNPageHandle, from source: UIViewController, presentation: URNPagePresentation,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        guard source.viewIfLoaded?.window != nil, source.presentedViewController == nil,
            source.transitionCoordinator == nil
        else {
            completion(.failure(URNContainerError("NAVIGATION_BUSY", "发起页面不可见或正在转场")))
            return
        }
        switch presentation {
        case .push:
            guard let navigation = source.navigationController,
                navigation.topViewController === source
            else {
                completion(.failure(URNContainerError("NAVIGATION_UNAVAILABLE", "发起页面没有可用导航栈")))
                return
            }
            navigation.pushViewController(page.viewController, animated: true)
            completeTransition(page.viewController, completion: completion)
        case .present:
            let navigation = UINavigationController(rootViewController: page.viewController)
            source.present(navigation, animated: true) { completion(.success(())) }
        }
    }

    public func close(_ page: URNPageHandle, completion: @escaping (Result<Void, Error>) -> Void) {
        let controller = page.viewController
        guard controller.transitionCoordinator == nil else {
            completion(.failure(URNContainerError("NAVIGATION_BUSY", "页面正在转场")))
            return
        }
        if let navigation = controller.navigationController,
            navigation.topViewController === controller
        {
            if navigation.viewControllers.count > 1 {
                navigation.popViewController(animated: true)
                completeTransition(controller, completion: completion)
            } else if navigation.presentingViewController != nil {
                navigation.dismiss(animated: true) { completion(.success(())) }
            } else {
                completion(.failure(URNContainerError("NAVIGATION_UNAVAILABLE", "不能关闭宿主导航根页面")))
            }
        } else if controller.presentingViewController != nil {
            controller.dismiss(animated: true) { completion(.success(())) }
        } else {
            completion(.failure(URNContainerError("NAVIGATION_UNAVAILABLE", "页面不是可关闭的栈顶页面")))
        }
    }

    private func completeTransition(
        _ controller: UIViewController, completion: @escaping (Result<Void, Error>) -> Void
    ) {
        if let transition = controller.transitionCoordinator {
            transition.animate(alongsideTransition: nil) { context in
                completion(
                    context.isCancelled
                        ? .failure(URNContainerError("NAVIGATION_CANCELLED", "导航转场已取消"))
                        : .success(()))
            }
        } else {
            completion(.success(()))
        }
    }
}

public enum URNPageResult {
    case completed([String: Any]?)
    case cancelled

    var json: [String: Any] {
        switch self {
        case .completed(let data):
            var result: [String: Any] = ["status": "completed"]
            if let data { result["data"] = data }
            return result
        case .cancelled: return ["status": "cancelled"]
        }
    }
}
