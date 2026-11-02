# URN

为iOS与Android App提供共享React Native运行时、多页面独立连接、导航返回值、生命周期和加载/错误/重试界面。URN管理RN容器，Aeris负责跨平台通信，两者为独立库。

预览版`0.3.0-preview.1`。npm `leo-urn`，iOS Pod `LeoURN`，Swift继续`import URN`。固定基线：RN0.87.0、React19.2.3、iOS15.1+、Android API24+/Java17。

## 安装

```sh
npm install --save-exact leo-urn@0.3.0-preview.1 aeris-client-core@0.26.0-preview.2 aeris-react-native@0.26.0-preview.2 react@19.2.3 react-native@0.87.0
npm install --save-dev --save-exact leo-urn-tooling@0.3.0-preview.1
```

RN自动链接LeoURN与AerisRN，iOS Podfile同时配置公开Specs `https://github.com/zhangguozhong/leo-podspecs.git` 与CocoaPods CDN，并按RN官方流程调用use_native_modules!/use_react_native!。不要为同名Pod重复声明不同来源。原生依赖统一Aeris `0.26.0-preview.2`。

## 创建独立调试壳或嵌入已有App

下载固定profile：`profiles/urn-rn087-0.3.0-preview.1.json`。profile 固定 SDK、开发工具、脚手架和 Aeris 的版本及摘要，用于创建可复现的工程。

```sh
npx --yes create-leo-urn@0.3.0-preview.1 --help

# Android独立工程
npx --yes create-leo-urn@0.3.0-preview.1 rn-integration --platform android --mode standalone --profile /absolute/urn-profile.json

# Android嵌入已有原生工程
npx --yes create-leo-urn@0.3.0-preview.1 rn-integration --platform android --mode embedded --android-project /absolute/HostApp --profile /absolute/urn-profile.json

# iOS嵌入已有原生工程
npx --yes create-leo-urn@0.3.0-preview.1 rn-integration --ios-project /absolute/HostApp/HostApp.xcodeproj --target HostApp --profile /absolute/urn-profile.json
```

输出目录名由命令指定，只使用ASCII名称。脚手架不覆盖已有宿主，先生成再按生成说明合并Podfile或Gradle接线。`npm run prepare:urn`按profile校验摘要并准备`.urn`；一个集成工程复用一份node_modules，不把各独立业务仓库的node_modules合并到App。

## 开发与正式出包

业务工程开启Metro，Debug使用Metro URL与Fast Refresh；Release聚合业务入口并打包离线bundle/资源。页面push/pop、返回结果、重试与连接各自隔离。最终页面关闭会等待Native清理与运行时销毁；Reload不能复活旧callback。

Android源码已包含Native生命周期与JNI接线；自有urnbindings库使用16KiB LOAD段。工具可调用`auditAndroidPageAlignment`检查APK/AAB/AAR，不代替设备运行和签名验收。Core可通过固定公开Aeris源码复用；直接Maven消费时，仓库地址为`https://raw.githubusercontent.com/zhangguozhong/aeris-maven/0.26.0-preview.2`。

## 页面与生命周期

多个原生页面共享 RN 运行时，各页独立管理连接、业务参数和 callback。页面返回支持结果回传；单页重试保留其他页面的状态。宿主关闭页面时应等待资源清理完成，再移除原生视图。

JS 注册和 iOS 宿主 API 见 [URN SDK](packages/urn/README.md)，工程命令见 [开发工具](packages/urn-tooling/README.md)。当前为预览版本，请按应用的目标设备和业务插件验证集成。

## 路由、恢复与宿主能力

本版本增加混合路由/深链、业务JSON状态恢复、有限故障降级、受控预热、模块能力清单、宿主环境同步、开发诊断面板和局部原生嵌入。共享RN运行时下，每个页面继续使用独立连接。

宿主提供路由表、认证守卫、跨栈dispatcher、环境及存储。清理必须等实际UI和业务资源释放；相同公开owner.id不会合并两个独立对象，快照固定创建用户域和模块基线。预热只回收未被活动页面使用的资源。

工程检查与升级预览：

```sh
npx urn capabilities --app /absolute/rn-integration
npx urn upgrade --app /absolute/rn-integration --target /absolute/target-profile.json --dry-run
```

`capabilities`只报告安装和宿主路径，不代表设备验收。升级命令只输出差异，不修改依赖或锁文件。接口见SDK源码中的ContainerCapabilities、HostEnvironment和DiagnosticPanel，以及iOS/Android同名能力文件。

## 许可证

[MIT](LICENSE)。
