# URN SDK

`leo-urn` 与同包的 `LeoURN.podspec` 提供 iOS 共享 RN Runtime 和独立页面连接。当前 `0.1.0` 是本地候选，尚未发布 npm 包、Pod 或 SDK tag；使用仓库 workspace、path 或经记录的 tarball 进行验收。固定 React `19.2.3`、RN `0.87.0`、Hermes/Fabric、最低 iOS `15.1`，外部 Aeris 来源见[兼容文档](../../docs/URN与Aeris兼容说明.md)。

SDK 源码位于 `packages/urn`。原生按 `Container`、`Routing`、`ReactNative`、`Modules` 分组；`URNReactHost` 封装 RN 宿主接线，JS 的 `PageCoordinator` 管理同一轮次的页面与关闭流程。它们是容器的内部实现，业务接入继续使用下文公开入口。

## JS 入口

业务包导出 `FeatureDefinition<P>`，App 组装注册表并调用一次 `registerFeatures`：

```tsx
import { FeatureRegistry, registerFeatures, type FeatureDefinition } from 'leo-urn';
import { Text } from 'react-native';

const account: FeatureDefinition<{ name: string }> = {
  id: 'account',
  component: ({ params }) => <Text>{params.name}</Text>,
  parseParams(raw) {
    if (typeof raw.name !== 'string') throw new Error('需要 name');
    return { name: raw.name };
  },
};
registerFeatures(new FeatureRegistry().register(account), { baselineId: 'urn-rn087' });
```

公开导出包括 `FeatureRegistry`、`registerFeatures`、`URNError`，以及 `FeatureDefinition`、`FeatureProps`、`FeatureEnvironment`、`BusinessBridge`、`ResolvedFeature`、`ContainerContext`、`ContainerProps`、`RegistrationOptions` 类型。业务使用 `environment.pageId`、`featureId` 和 `bridge.call/subscribe`，不取得 Client 的销毁接口，不自行调用 AppRegistry。重复 ID、未知业务、非 JSON 参数或参数解析失败会明确报错。

RootKey 固定为 `URNRoot`。`NativeURNChannel` 和 `NativeURNLifecycle` 是容器自己的 Codegen 模块；Aeris 原生模块保留原名。generation 由实际 Host 的 `didInitializeRuntime` 注入字符串全局 `__URNGeneration`，JS 不生成替代值。`registerFeatures` 注册 Root 后在下一 JS turn 发出 boot，供原生确认 bundle 顶层已经执行完成。React effect 的 mounted、Aeris握手的bridgeReady、业务子树提交的ready是不同信号。

## iOS 入口

由 App 提供同一 RN 工程生成的 `RCTAppDependencyProvider`、bundle URL 和 Engine，公共 Pod 不包含某个 App 的 Provider：

```swift
import Aeris
import URN
import ReactAppDependencyProvider

let configuration = try URNConfiguration(
    engine: BridgeEngine.shared,
    baselineId: "urn-rn087",
    bundleURL: bundleURL,
    dependencyProvider: RCTAppDependencyProvider())
let coordinator = URNCoordinator(configuration: configuration)
var page = URNPageConfiguration()
page.allowedPermissions = []
page.allowedEventTopics = ["demo.changed"]
page.cleanup = { done in
    // 业务任务取消及 UI dismiss 真正完成后回调；done 必须回到主线程。
    done(.success(()))
}
let handle = try coordinator.open(featureId: "account", params: ["name": "Alice"], page: page) {
    handle, result in
    // 首次通信成功并完成业务子树提交的结果；不在此处重复 push。
}
navigationController.pushViewController(handle.viewController, animated: true)
```

上述 UIKit/Engine API 在 MainActor 上调用。可使用 callback/GCD；后台工作完成后回主线程调用 completion，不要求业务改用 async/await。`engine` 参数类型为 Aeris 的 `BridgeEngine`。宿主可传 `BridgeEngine.shared` 或独立实例；已有应用级封装时传入它持有的 BridgeEngine，注册业务能力的职责仍在 App。

`open` 同步返回包含占位 VC 的 handle，随后异步初始化；先 push，再观察 `onReady`。`URNConfiguration` 初始化可能抛错，`URNCoordinator(configuration:)` 不抛错。可调整 `maxPages`、`startupTimeout`、`closeWindow`、`cleanupTimeout` 和 `onDiagnostic`。关闭中的记录仍占页面预算。

| API                                       | 完成条件                                                       |
| ----------------------------------------- | -------------------------------------------------------------- |
| `close(handle, completion:)`              | 本页 JS/原生连接和业务 cleanup 完成；不保证整个 Runtime 已释放 |
| `closePages(in: navigation, completion:)` | 指定导航容器内所有页面完成关闭，包含被普通原生页覆盖的 RN 页面 |
| `closeAll(completion:)`                   | 所有页面完成关闭，并通过真实 Runtime 释放屏障                  |
| `reload(completion:)`                     | 旧轮次关闭和释放，新轮次仍存在的页面全部重建；期间拒绝新 open  |
| `retryCleanup(handle, completion:)`       | 显式重试已失败的释放；不自动恢复失败 Reload                    |

## 宿主必须接线的生命周期

正常导航 pop 会自动关闭对应页面；手势返回取消、被下一页覆盖及 App 后台不关闭。任意 modal/wrapper 的呈现方必须在确认 dismiss 完成后通知 Coordinator：

```swift
presenter.dismiss(animated: true) {
    coordinator.closePages(in: modalNavigation) { result in
        // 检查页面关闭结果。
    }
}
```

这项接线尤其适用于 modal 导航顶部是普通原生页面、RN 页面不可见的情况。可见 RN VC 的自动辅助回调不能替代呈现方的公开义务。

关闭顺序为 Engine beginClosing → JS dispose（取消/退订/bridge.close）→ disposed 或有限窗口兜底 → 原生 ReceiverFactory 关闭 → 宿主 cleanup 实际完成 → Root mounted 安全停止 → 删除页面记录 → 最后一页触发 Runtime 释放。early dispose 后才收到 mounted 是合法时序；不能仅凭已初始化 JSI 就提前销毁仍在执行 bundle 的 Host。

cleanup 超时或失败保留记录及 Root，返回失败；已知失败时重复 close 直接返回失败，不自动重试。完整 Reload 任意页面清理或重挂载失败会停止整个 Runtime 的继续服务，不保留半恢复页面；清理失败的资源仍等待显式释放重试。

## 工程和依赖

从集成 App 解析 RN 与自动链接，不要求 App/node_modules 实际存在。App 显式安装 SDK、业务包、Aeris Core/RN 和原生插件并集，React/RN/SDK 在业务包中使用 peer，统一由安装根及 lockfile 决定。新增原生依赖后重新 pod install 并编译。

完整可运行入口见[iOS 集成示例](../../examples/ios-host/URN/Integration/README.md)，两种业务组织方式见[接入指南](../../docs/URN业务接入指南.md)。Android、多 Runtime、跨 Scene 和热 OTA 尚未实现。

## 统一预算与诊断

```swift
var configuration = try URNConfiguration(
    engine: BridgeEngine.shared, baselineId: "urn-rn087", bundleURL: url,
    dependencyProvider: RCTAppDependencyProvider())
configuration.maxPages = 8
configuration.channelBudget.nativeBytes = 8 * 1024 * 1024
configuration.channelBudget.nativeBatchSize = 8
configuration.onDiagnosticEvent = { event in
    print(event.stage, event.pageId ?? "", event.durationMs ?? 0)
}
let coordinator = URNCoordinator(configuration: configuration)
```

```ts
registerFeatures(registry, {
  baselineId: 'urn-rn087',
  onDiagnostic: (event) => logger.record(event),
});
```

logger 是项目提供的日志服务。诊断默认不含业务参数、回包、extra、原始错误和 featureId；业务 ID 只有在显式设置 includeFeatureIdsInDiagnostics 后包含。原生事件延后至主队列，JS 事件延后至微任务，观察器不拥有关闭屏障。Swift 非 throwing 回调不能恢复 fatalError 或进程异常。

maxPages 决定本轮有效容量且不能大于 channelBudget.maxChannels。默认预算从同一个 JSON 生成三端代码，Native 在 JSI 初始化时注入快照；同轮 Fast Refresh 不修改它。`coordinator.channelBudgetSnapshot`、`coordinator.messageQueueSnapshot` 可查看数值，详细字段、范围和计量语义见设计文档。

上述隐私白名单仅适用于新的结构化诊断事件；旧 `onDiagnostic(code,message)` 和 `onError` 保留原始语义，宿主记录它们时仍需自行脱敏。

## 页面体验接口

`environment.lifecycle` 提供不可变 snapshot 与立即回放的 subscribe；`environment.navigation.open` 返回 completed/cancelled 结果，close(data) 在完成导航移除后回传。宿主配置 `navigator`、`navigationPageConfiguration` 与 `pageUI`。局部失败安全清理后 `handle.canRetry=true`，可 `handle.retry`；同 Handle/pageId 使用新 channel，兄弟页保留原 Client。`handle.finish(result:)` 提交结果并移除页面，`handle.close` 仍只负责资源清理。

完整代码和边界见[页面生命周期、导航与重试接入指南](https://github.com/zhangguozhong/URN/blob/main/docs/URN页面生命周期与导航指南.md)。

### 出站确认、首屏和导航恢复

容器自动按实际消费确认Native→JS帧；业务API和Aeris JSON不变。等待与在途帧同时计入独立出站预算，关闭使用有界控制槽。新增`channelBudget.nativeOutboundWindow`（默认4）及`nativeOutboundGlobalWindow`（默认64），实际单页窗口受全局预算按页面数分配约束。

`onReady`等待通信成功和业务子树提交，握手阶段仍显示加载。首屏渲染错误或提交超时走单页失败与重试。

`configuration.navigationTimeout`（默认15秒）保护宿主打开/关闭操作。`handle.navigationError`和`canRetryNavigationClose`表示UI仍待移除；恢复宿主导航后调用`handle.retryNavigationClose()`。关闭失败会向JS onError报告，不能将取消确认等同于UI关闭。参见[生命周期与导航指南](https://github.com/zhangguozhong/URN/blob/main/docs/URN页面生命周期与导航指南.md)。

## 安装包接入

JS、类型、Codegen 和 iOS 源码随同一 `leo-urn` 包分发。Pod 使用 node_modules 中的 LeoURN.podspec 自动链接，不要再手动引入另一版本的 URN Pod。当前为未发布候选；完整版本约束、制品准备和独立验收步骤见[安装包与 Pod 验收](https://github.com/zhangguozhong/URN/blob/main/docs/URN安装包与Pod验收.md)。私有仓库文档需要读取权限。
