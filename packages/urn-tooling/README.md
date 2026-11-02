# leo-urn-tooling

URN 工程开发工具，0.3.0-preview.1 为预览版本。通过 App 的 devDependencies 安装，复用同一份平台检查与 bundle 包装器。

- `urn prepare [--app DIR]`：按 urn.profile.json 准备校验后的本地 tarball 和 Aeris Native 固定源码。
- `urn baseline [--app DIR] [--output FILE]`：npm/Pods 安装后捕获真实锁摘要和工具链，已有文件不覆盖，结果须审阅。
- `urn doctor --app DIR`、`urn check-baseline --app DIR --baseline FILE --release`：依赖与基线门禁。
- `urn create-artifacts ...`、`urn verify-artifacts ...`：继承平台工具参数，使用真实 Xcode target 和唯一 bundle phase。

dist/bundle-ios.sh 放进 RN 标准 bundle phase，生成聚合 bundle/资源。该包不创建 AppDelegate、不自动修改签名或执行 pod install。

冷启动时还未安装本工具，用脚手架生成的 prepare-urn.mjs（仅 Node 标准库）恢复依赖，再 npm ci。不要把预先安装本工具作为恢复前提。

## Android 开发与构建


- `urn android-build --app DIR --variant debug --metro --install`：真实Gradle安装Debug；独立壳可加 `--launch`，嵌入模式启动须显式Activity。
- `urn android-probe --app DIR`：真实Gradle模型；`urn baseline --app DIR`捕获Android锁/配置基线，已有文件不覆盖。
- `urn android-build --app DIR --variant release [--bundle]`：重新探针、校验基线、R8/Hermes离线构建；签名由宿主提供。
- `urn android-audit` / `urn android-aar`：检查已有实际ZIP、bundle/ABI/JNI或AAR类与consumer规则，不代替运行及签名验收。

## 能力检查与升级预览

`urn capabilities --app DIR`检查实际安装及container.project.json声明的ios/android宿主路径。`urn upgrade --app DIR --target PROFILE --dry-run`输出精确配套差异，不修改锁文件。静态检查不代替Native编译及设备验收。
