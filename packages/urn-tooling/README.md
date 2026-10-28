# leo-urn-tooling

URN 工程开发工具，0.1.0 为预览版本。通过 App 的 devDependencies 安装，复用同一份平台检查与 bundle 包装器。

- `urn prepare [--app DIR]`：按 urn.profile.json 准备校验后的本地 tarball 和 Aeris Native 固定源码。
- `urn baseline [--app DIR] [--output FILE]`：npm/Pods 安装后捕获真实锁摘要和工具链，已有文件不覆盖，结果须审阅。
- `urn doctor --app DIR`、`urn check-baseline --app DIR --baseline FILE --release`：依赖与基线门禁。
- `urn create-artifacts ...`、`urn verify-artifacts ...`：继承平台工具参数，使用真实 Xcode target 和唯一 bundle phase。

dist/bundle-ios.sh 放进 RN 标准 bundle phase，生成聚合 bundle/资源。该包不创建 AppDelegate、不自动修改签名或执行 pod install。

冷启动时还未安装本工具，用脚手架生成的 prepare-urn.mjs（仅 Node 标准库）恢复依赖，再 npm ci。不要把预先安装本工具作为恢复前提。
