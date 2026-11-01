# create-leo-urn

为已有 iOS App 创建 URN 业务工程。公开预览版 0.2.0-preview.2；RN 0.87.0、React 19.2.3、iOS 15.1+。

先有能运行的 Xcode App 工程，再从其父目录执行：

```sh
curl -fL \
  https://raw.githubusercontent.com/zhangguozhong/leo-urn/400b0ff33ce42959253ade77e895b4bc4a9124c2/profiles/urn-rn087-0.2.0-preview.2.json \
  -o urn-profile.json
npm exec --yes --registry=https://registry.npmjs.org --package=create-leo-urn@0.2.0-preview.2 -- \
  create-leo-urn ./order-rn \
  --ios-project ./HostApp/HostApp.xcodeproj --target HostApp \
  --profile ./urn-profile.json --install
```

OUTPUT 是新目录，不支持中文，支持英文和空格。`--name` 指定 npm 包名；`--dry-run` 只检查，不与 `--install` 同用。命令不修改原 Xcode 工程，不创建 App、签名或另一套 RN Factory。

profile 固定四个 SDK/工具包及 create 自身的版本、来源和 SHA256。公共版本从 npm 下载校验后存入 `.urn/packages`，生成 package.json 使用其 file:tarball，属于公共包缓存。Aeris Native 下载为 `.urn/aeris` 中固定的公开源码；可保留模板 Pod :path，也可将三个 Aeris Pod 改为公开 Specs 的精确版本。LeoURN/AerisRN 从 npm 自动链接，不重复手写同名 Pod。

生成后把 Podfile、URNAppIntegration.swift、Info.plist 和唯一 bundle phase 合入 App，App target 的 ENABLE_USER_SCRIPT_SANDBOXING 设为 NO；Debug Metro 配置 NSAllowsLocalNetworking。独立壳启动后直接打开 RN；嵌入宿主由原生路由打开同一 Feature。首次无锁使用 npm install；提交锁后，干净检出可运行 `npm run prepare:urn`、`npm ci`、`npm run typecheck`、`npm run doctor` 恢复。

Pod 安装完成后执行 baseline:prepare，审阅真实基线再 baseline:check。Debug 设置 Run 环境 URN_BUNDLE_MODE=metro 并启动 Metro；Release 使用 embedded，停止 Metro 后实际验收。签名和 IPA 导出由宿主负责。

0.2.0-preview.2 已发布包中的生成 README 有旧发布文案；源代码说明修订不会覆盖已发布 tarball。完整公开接入说明见 [leo-urn](https://github.com/zhangguozhong/leo-urn)。

## Android候选能力


- `urn android-build --app DIR --variant debug --metro --install`：真实Gradle安装Debug；独立壳可加 `--launch`，嵌入模式启动须显式Activity。
- `urn android-probe --app DIR`：真实Gradle模型；`urn baseline --app DIR`捕获Android锁/配置基线，已有文件不覆盖。
- `urn android-build --app DIR --variant release [--bundle]`：重新探针、校验基线、R8/Hermes离线构建；签名由宿主提供。
- `urn android-audit` / `urn android-aar`：检查已有实际ZIP、bundle/ABI/JNI或AAR类与consumer规则，不代替运行及签名验收。

