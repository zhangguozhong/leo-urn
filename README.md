# URN

为iOS与Android App提供共享React Native运行时、多页面独立连接、导航返回值、生命周期和加载/错误/重试界面。URN管理RN容器，Aeris负责跨平台通信，两者为独立库。

预览版`0.2.0-preview.1`。npm `leo-urn`，iOS Pod `LeoURN`，Swift继续`import URN`。固定基线：RN0.87.0、React19.2.3、iOS15.1+、Android API24+/Java17。

## 安装

```sh
npm install --save-exact leo-urn@0.2.0-preview.1 aeris-client-core@0.26.0-preview.1 aeris-react-native@0.26.0-preview.1 react@19.2.3 react-native@0.87.0
npm install --save-dev --save-exact leo-urn-tooling@0.2.0-preview.1
```

RN自动链接LeoURN与AerisRN，iOS Podfile同时配置公开Specs `https://github.com/zhangguozhong/leo-podspecs.git` 与CocoaPods CDN，并按RN官方流程调用use_native_modules!/use_react_native!。不要为同名Pod重复声明不同来源。原生依赖统一Aeris `0.26.0-preview.1`。

## 创建独立调试壳或嵌入已有App

下载固定profile：`profiles/urn-rn087-0.2.0-preview.1.json`。profile包含四个npm包、脚手架SHA256及公开Aeris源码commit；不能用浮动main或不匹配版本替换。

```sh
npx --yes create-leo-urn@0.2.0-preview.1 --help

# Android独立工程
npx --yes create-leo-urn@0.2.0-preview.1 rn-integration --platform android --mode standalone --profile /absolute/urn-profile.json

# Android嵌入已有原生工程
npx --yes create-leo-urn@0.2.0-preview.1 rn-integration --platform android --mode embedded --android-project /absolute/HostApp --profile /absolute/urn-profile.json

# iOS嵌入已有原生工程
npx --yes create-leo-urn@0.2.0-preview.1 rn-integration --ios-project /absolute/HostApp/HostApp.xcodeproj --target HostApp --profile /absolute/urn-profile.json
```

输出目录名由命令指定，只使用ASCII名称。脚手架不覆盖已有宿主，先生成再按生成说明合并Podfile或Gradle接线。`npm run prepare:urn`按profile校验摘要并准备`.urn`；一个集成工程复用一份node_modules，不把各独立业务仓库的node_modules合并到App。

## 开发与正式出包

业务工程开启Metro，Debug使用Metro URL与Fast Refresh；Release聚合业务入口并打包离线bundle/资源。页面push/pop、返回结果、重试与连接各自隔离。最终页面关闭会等待Native清理与运行时销毁；Reload不能复活旧callback。

Android源码已包含Native生命周期与JNI接线；自有urnbindings库使用16KiB LOAD段。工具可调用`auditAndroidPageAlignment`检查APK/AAB/AAR，不代替设备运行和签名验收。Core可通过固定公开Aeris源码复用；直接Maven消费时，仓库地址为`https://raw.githubusercontent.com/zhangguozhong/aeris-maven/0.26.0-preview.1`。

`next`为预览，`latest`保持原版本。模拟器和本机Debug/Release构建已有覆盖；真实手机、OS长期后台及生产签名包不在本轮已完成范围。SDK不包含业务App、UnityFramework或私有设计文档。

MIT。
