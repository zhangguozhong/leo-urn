# URN

URN 为 iOS App 提供共享 React Native 运行时、多页面独立连接、导航返回值、生命周期和错误重试。

- npm：`leo-urn`
- iOS Pod：`LeoURN`
- Swift 模块：`URN`，使用 `import URN`
- 工具：`leo-urn-tooling`、`create-leo-urn`
- 基线：React Native 0.87.0、React 19.2.3、iOS 15.1+

当前为公开发布候选，尚未发布。以下步骤在依赖和本库正式发布后使用。

## 安装

App 同时安装 JS 包及所要求的 Aeris Core/RN 精确版本。原生代码由 `leo-urn` 内的 `LeoURN.podspec` 自动链接，避免另外安装不同来源的同名 Pod。

```sh
npm install leo-urn react@19.2.3 react-native@0.87.0 aeris-client-core@0.25.0 aeris-react-native@0.25.0
```

生产工程使用经过验证的精确版本和锁文件，不将上述命令理解为任意最新版均兼容。Aeris 0.25.0 的源码候选已准备；正式安装仍需等待 npm/Pod 发布完成。

在宿主 Podfile 加载 RN 官方 `react_native_pods`，执行 `prepare_react_native_project!`，在 RN 工程目录执行 `use_native_modules!`，再调用 `use_react_native!`。已有业务 Pods 和 `post_install` 应合并保留。

```ruby
config = Dir.chdir(app_root) { use_native_modules! }
use_react_native!(:path => config[:reactNativePath], :app_path => app_root)
```

`app_root` 是业务 RN 工程目录。Aeris 原生 Pods 必须从已发布的同一兼容版本解析。`pod install` 成功后，通过 App 持有的 `URNCoordinator` 打开页面；Swift 使用 `import URN`。

## 开发与构建

业务工程启动 Metro，原生 App 的 Debug 配置使用 Metro bundle URL。Release 必须包含聚合 JS bundle 与资源；关闭、重试和返回结果按页面连接隔离。

本候选验收覆盖 iOS 模拟器 Release、多页面、callback、事件、取消、关闭和 Metro Fast Refresh。尚未声明 Android、真机签名或 App Store Archive 验收通过。

## 许可

MIT，各包包含 LICENSE。此源码交付目录不包含内部设计文档、测试日志或 Git 历史。
