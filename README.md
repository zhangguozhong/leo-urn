# URN

URN 为 iOS App 提供共享 React Native 运行时、多页面独立连接、导航返回值、生命周期和错误重试。

- npm：`leo-urn`
- iOS Pod：`LeoURN`
- Swift 模块：`URN`，使用 `import URN`
- 工具：`leo-urn-tooling`、`create-leo-urn`
- 基线：React Native 0.87.0、React 19.2.3、iOS 15.1+

0.1.0 为预览版本，首次公开发布使用 next 标签。具体是否可安装，以 npm registry 和公开 Specs 索引为准。

## 安装

App 同时安装 JS 包及所要求的 Aeris Core/RN 精确版本。原生代码由 `leo-urn` 内的 `LeoURN.podspec` 自动链接，避免另外安装不同来源的同名 Pod。

```sh
npm install --save-exact leo-urn@0.1.0 react@19.2.3 react-native@0.87.0 aeris-client-core@0.25.0 aeris-react-native@0.25.0
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

## 固定 profile 与脚手架

首次接入已有 iOS App，可下载本版本的固定 profile，再运行已发布脚手架。先用 Xcode 创建或选定真实 App target；目录名由调用者指定。

```sh
curl -fL https://raw.githubusercontent.com/zhangguozhong/leo-urn/main/profiles/urn-rn087-0.1.0.json -o urn-profile.json
npm exec --yes --package=create-leo-urn@0.1.0 -- create-leo-urn ./rn-integration \
  --ios-project ./HostApp/HostApp.xcodeproj --target HostApp \
  --profile ./urn-profile.json --install
```

profile 固定五个 npm 制品的精确版本与 SHA256，以及 Aeris 的公开源码 commit。脚手架当前生成的 Podfile 示例使用下载到 `.urn/aeris` 的固定源码；若采用公开 Specs，请把三个 Aeris 原生 Pod 的 `:path` 声明改为下列固定版本来源，保留 RN 自动链接及唯一 post_install：

```ruby
source 'https://github.com/zhangguozhong/leo-podspecs.git'
source 'https://cdn.cocoapods.org/'
# App target 内：
pod 'AerisContracts', '= 0.25.0'
pod 'Aeris', '= 0.25.0'
pod 'AerisHost', '= 0.25.0'
```

`LeoURN` 与 `AerisRN` 随 npm 安装自动链接，不重复手动声明其他来源。Swift 仍使用 `import URN`。profile 文件名带版本号，后续版本新增文件，不覆盖旧版本。
