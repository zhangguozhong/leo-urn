import UIKit

public struct URNPageLifecycle: Equatable, Sendable {
    public internal(set) var visible = false
    public internal(set) var foreground = true
    public internal(set) var closed = false
}

/// 每个页面独立的覆盖视图。闭包由宿主替换，retry 只恢复当前页面。
@MainActor public struct URNPageUI {
    public var loading: (URNPageHandle) -> UIView
    public var failure: (URNPageHandle, Error, Bool, @escaping () -> Void) -> UIView

    public init(
        loading: @escaping (URNPageHandle) -> UIView = { _ in
            let spinner = UIActivityIndicatorView(style: .large)
            spinner.startAnimating()
            return URNPageUI.container([spinner, URNPageUI.label("正在加载…")], id: "urn.loading")
        },
        failure: @escaping (URNPageHandle, Error, Bool, @escaping () -> Void) -> UIView = {
            _, _, canRetry, retry in
            let button = UIButton(type: .system)
            button.setTitle(canRetry ? "重试" : "正在清理，请稍候", for: .normal)
            button.isEnabled = canRetry
            button.accessibilityIdentifier = "urn.retry"
            button.addAction(UIAction { _ in retry() }, for: .touchUpInside)
            return URNPageUI.container([URNPageUI.label("页面加载失败"), button], id: "urn.error")
        }
    ) {
        self.loading = loading
        self.failure = failure
    }

    public static func label(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.textAlignment = .center
        label.numberOfLines = 0
        return label
    }

    public static func container(_ children: [UIView], id: String) -> UIView {
        let view = UIView()
        view.backgroundColor = .systemBackground
        view.accessibilityIdentifier = id
        let stack = UIStackView(arrangedSubviews: children)
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -48),
        ])
        return view
    }
}

/// NotificationCenter 的 token 不参与状态访问，只负责随容器释放移除监听。
final class URNApplicationObservation: @unchecked Sendable {
    private var tokens: [NSObjectProtocol] = []
    @MainActor init(_ update: @escaping @MainActor (Bool) -> Void) {
        for (name, foreground) in [
            (UIApplication.didEnterBackgroundNotification, false),
            (UIApplication.willEnterForegroundNotification, true),
        ] {
            tokens.append(
                NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) {
                    _ in MainActor.assumeIsolated { update(foreground) }
                })
        }
    }
    deinit { tokens.forEach { NotificationCenter.default.removeObserver($0) } }
}
