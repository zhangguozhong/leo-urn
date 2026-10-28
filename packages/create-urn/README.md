# create-leo-urn

为已有 iOS App 创建 URN 业务工程。RN 0.87.0 / React 19.2.3 / iOS 15.1+，0.1.0 为预览版本。

```sh
# 从已验证的本地 create 制品启动，不依赖预先安装的全局工具。
npm exec --yes --package=/absolute/path/create-leo-urn-0.1.0.tgz -- \
  create-leo-urn ./order-rn \
  --ios-project ./HostApp/HostApp.xcodeproj --target HostApp \
  --profile /absolute/path/urn-profile.json --install
```

OUTPUT 是新目录，不支持中文，支持英文和空格。--name 可指定 npm 包名；默认按目录生成小写名称。--dry-run 只检查、不创建，不与 --install 同用。已有目录、缺失 App target、危险 shell 路径或不匹配的包来源都会拒绝；原 Xcode 工程不会被修改。

profile 包含四个 App 工具/SDK tarball 的 name/version/specifier/SHA256、create 自身的固定制品，以及 Aeris capability 与原生 Git 完整 ref。specifier 支持本地 file:tarball、无凭据查询参数的 HTTPS tarball、精确 name@version（使用调用者 npm registry 配置）。私有读取权限通过 npm/Git 的既有凭据管理，不写 token URL。

生成后先按工程根 README.md合并原生 Podfile、Swift 和唯一 bundle phase。首次无锁用 npm install；之后可删除 node_modules 和 .urn，再运行 npm run prepare:urn、npm ci 恢复，不需要 URN 源码目录。源制品仍须存在或可从私有 registry 取得。

Pod 安装完成后执行 npm run baseline:prepare，审阅实际锁与工具链捕获的基线，再 baseline:check。不会填入样例 hash 或自动覆盖旧基线。

SDK 的 iOS 源码由 node_modules/leo-urn 中的 Podspec 自动链接；Aeris 的固定公开源码由工具固定下载到 .urn/aeris 并供 Pod :path 使用，不要求复制 vendor/urn。
