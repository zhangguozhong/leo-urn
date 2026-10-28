import { bootstrapScript } from './bootstrap.mjs';
import { archiveName } from '../lib/profile.mjs';
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const plugins = [
  {
    name: 'leo-urn',
    version: '0.1.0',
    pods: [{ name: 'LeoURN', version: '0.1.0' }],
    codegen: { name: 'URNSpec', type: 'modules' },
  },
  {
    name: 'aeris-react-native',
    version: '0.25.0',
    pods: [{ name: 'AerisRN', version: '0.25.0' }],
    codegen: { name: 'NativeUnifiedBridgeSpec', type: 'modules' },
  },
];

export function templates({ profile, name, iosProject, target, hostFromApp, appFromHost }) {
  const deps = Object.fromEntries(
    profile.packages
      .filter((p) => p.name !== 'leo-urn-tooling')
      .map((p) => [p.name, `file:.urn/packages/${archiveName(p)}`]),
  );
  const phase =
    [
      'set -e',
      `export PROJECT_ROOT="$PROJECT_DIR/${appFromHost}"`,
      'export ENTRY_FILE=index.container.js',
      'export FORCE_BUNDLING=1',
      'export NODE_BINARY="${NODE_BINARY:-$(command -v node)}"',
      `RN_ROOT="$("$NODE_BINARY" -p 'require("path").dirname(require.resolve("react-native/package.json", {paths: [process.env.PROJECT_ROOT]}))')"`,
      `/bin/bash "$PROJECT_DIR/${appFromHost}/node_modules/leo-urn-tooling/dist/bundle-ios.sh" "$PROJECT_ROOT" "$RN_ROOT"`,
    ].join('\n') + '\n';
  const files = {
    'package.json': json({
      name,
      version: '1.0.0',
      private: true,
      scripts: {
        start: 'react-native start',
        typecheck: 'tsc --noEmit',
        'prepare:urn': 'node prepare-urn.mjs',
        doctor: 'urn doctor --app .',
        'baseline:prepare': 'urn baseline --app .',
        'baseline:check': 'urn check-baseline --app . --baseline platform-baseline.json --release',
      },
      dependencies: { react: '19.2.3', 'react-native': '0.87.0', ...deps },
      devDependencies: {
        'leo-urn-tooling': 'file:.urn/packages/leo-urn-tooling-0.1.0.tgz',
        '@react-native-community/cli': '20.2.0',
        '@react-native-community/cli-platform-ios': '20.2.0',
        '@react-native/metro-config': '0.87.0',
        '@react-native/babel-preset': '0.87.0',
        '@types/react': '19.2.3',
        typescript: '5.9.3',
      },
      urn: { features: [], nativePlugins: plugins },
    }),
    '.gitignore': 'node_modules/\n.urn/\ndist/\n.DS_Store\n',
    'urn.profile.json': json(profile),
    'aeris-capabilities.json': json(profile.aeris),
    'urn.project.json': json({ schemaVersion: 1, iosProject, target }),
    'prepare-urn.mjs': bootstrapScript,
    'index.container.js': `import { registerFeatures } from 'leo-urn';\nimport { registry } from './src/registry';\nregisterFeatures(registry, { baselineId: ${JSON.stringify(profile.baselineId)} });\n`,
    'metro.config.js':
      "const { getDefaultConfig } = require('@react-native/metro-config');\nmodule.exports = getDefaultConfig(__dirname);\n",
    'babel.config.js': "module.exports = { presets: ['module:@react-native/babel-preset'] };\n",
    'react-native.config.js': `module.exports = ${json({ project: { ios: { sourceDir: hostFromApp } } }).trim()};\n`,
    'tsconfig.json': json({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        jsx: 'react-jsx',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowJs: false,
        types: ['react'],
      },
      include: ['src/**/*.ts', 'src/**/*.tsx'],
    }),
    'src/features/HomeScreen.tsx': `import { Button, Text, View } from 'react-native';
import type { FeatureProps } from 'leo-urn';

export function HomeScreen({ params, environment }: FeatureProps<{ message: string }>) {
  return (
    <View>
      <Text>{params.message}</Text>
      <Button
        title="调用原生"
        onPress={() => {
          environment.bridge.call('URNExample.echo', { value: params.message }, (error, data) => {
            if (error) console.warn(error.code);
            else console.log(data);
          });
        }}
      />
    </View>
  );
}
`,
    'src/registry.ts': `import { FeatureRegistry, type FeatureDefinition } from 'leo-urn';\nimport { HomeScreen } from './features/HomeScreen';\nconst home: FeatureDefinition<{ message: string }> = {\n  id: 'home', component: HomeScreen,\n  parseParams(raw) { return { message: typeof raw.message === 'string' ? raw.message : 'URN 已连接' }; },\n};\nexport const registry = new FeatureRegistry().register(home);\n`,
    'ios-integration/bundle-phase.sh': phase,
    'ios-integration/Info.plist.fragment':
      '<key>URNBundleMode</key><string>$(URN_BUNDLE_MODE)</string>\n<key>URNBuildConfiguration</key><string>$(CONFIGURATION)</string>\n<key>URNBaselineId</key><string>$(URN_BASELINE_ID)</string>\n',
    'ios-integration/Podfile.example': `# 合并到原生工程的 Podfile，不能在本模板目录执行 pod install。\nrequire 'pathname'\napp_root = File.expand_path('${appFromHost}', __dir__)\nrn_manifest = Pod::Executable.execute_command('node', ['-p', 'require.resolve("react-native/package.json", {paths: [process.argv[1]]})', app_root]).strip\nrequire File.join(File.dirname(rn_manifest), 'scripts/react_native_pods')\nprepare_react_native_project!\nplatform :ios, '15.1'\nuse_frameworks! :linkage => :static\nproject '${iosProject.split('/').at(-1)}'\naeris = Pathname.new(File.join(app_root, '.urn/aeris')).relative_path_from(Pathname.new(__dir__)).to_s\ntarget '${target}' do\n  pod 'AerisContracts', :path => File.join(aeris, 'native/ios/contracts')\n  pod 'Aeris', :path => File.join(aeris, 'native/ios/aeris')\n  pod 'AerisHost', :path => File.join(aeris, 'native/ios/host')\n  config = Dir.chdir(app_root) { use_native_modules! }\n  use_react_native!(:path => config[:reactNativePath], :app_path => app_root)\n  post_install do |installer|\n    react_native_post_install(installer, config[:reactNativePath], :mac_catalyst_enabled => false)\n  end\nend\n`,
    'ios-integration/URNAppIntegration.swift': swiftIntegration(profile.baselineId),
    'README.md': `# ${name}\n\n由 create-leo-urn 生成。iOS 15.1+，RN 0.87.0、React 19.2.3，单运行时、多页独立连接。\n\n## 首次安装与 CI\n\n即使没有 node_modules，也可以从工程根执行：\n\n\`\`\`sh\nnpm run prepare:urn\nnpm ci\nnpm run typecheck\nnpm run doctor\n\`\`\`\n\n首次还没有 package-lock.json 时把 npm ci 换为 npm install，审阅并提交锁。构建需要 devDependencies，不使用 --omit=dev。本地 profile 的制品路径必须能在该机器获取；CI 使用固定私有制品/registry profile，并配置自己的 npm/Git 凭据。prepare 校验来源和摘要，恢复忽略的 .urn 缓存；不要删掉源制品本身。\n\n## 接入已有原生 App\n\n1. 按 ios-integration/Podfile.example 合并原有 Podfile，保留业务 Pods、target 和 post_install；URN/AerisRN 由 npm 自动链接，不重复安装同名库。\n2. 在原生工程目录 bundle exec pod install；首次先准备受支持的 Ruby/Gemfile/Bundler，CocoaPods 1.16.2。\n3. 把 ios-integration/URNAppIntegration.swift 加入 App target，在原生组装层创建并强持有一份，调用 openHome；不要另外启动默认 RN Factory。\n4. 将唯一 RN bundle phase 改为 bundle-phase.sh 的七行内容，Shell /bin/sh，取消 Based on dependency analysis；不要新增重复 phase。\n5. 将 Info.plist.fragment 合并至真实 Info.plist；Build Settings 设置 URN_BUNDLE_MODE=embedded、URN_BASELINE_ID=${profile.baselineId}，App 最低 iOS 15.1。\n6. 本工程 npm start，Xcode Debug Run 环境 URN_BUNDLE_MODE=metro；真机可用 URN_METRO_URL 指向开发机 IP 和 index.container.bundle。\n7. pod install 完成后 npm run baseline:prepare；审阅生成的 platform-baseline.json，再 npm run baseline:check。基线已经存在时，使用 urn baseline --output platform-baseline.candidate.json，不自动覆盖旧基线。\n\n## 正式构建\n\nprepare → npm ci → 业务构建/类型检查 → pod install --deployment → doctor / baseline:check → 宿主自己的 Release build/archive → 断开 Metro 验收。工具不替你签名或导出 IPA。main.jsbundle/资源由唯一 phase 生成，当前无 OTA。\n\n## 页面与导航\n\n业务使用 environment.lifecycle.subscribe 监听页面显示／后台，使用 environment.navigation.open 等待目标页结果，navigation.close(data) 返回数据。局部错误页清理完成后可点击重试，只替换该页连接。宿主可配置 navigator、navigationPageConfiguration 和 pageUI。\n\n## 关闭\n\n正常导航 pop 自动清理；被遮挡、切后台不关闭。modal 的呈现方在 dismiss 完成后调用 coordinator.closePages(in:)。整体退出调用 closeAll 等待完成；业务 cleanup 要等真实资源释放，不能提前成功。\n\n## 生成边界\n\n命令只创建本工程和接入模板，没有修改原 App 的 Podfile、AppDelegate、签名或导航。原生工程：${iosProject}，target：${target}。当前依赖是未发布候选，.urn/aeris 是自动准备的固定 Aeris 原生缓存，由 Pod :path 使用；URN 原生实现来自 node_modules/leo-urn，无需 vendor/urn。未来发布后更新固定 profile，不能改用来源不一致的同号旧包。\n`,
  };
  return files;
}

function swiftIntegration(baseline) {
  return `import Aeris
import ReactAppDependencyProvider
import UIKit
import URN

/// App 强持有一份；每次 open 独立创建页面和连接。
@MainActor
final class URNAppIntegration {
    let coordinator: URNCoordinator
    private let example = URNExampleBridge()

    init(engine: BridgeEngine = .shared) throws {
        // 示例业务可由宿主替换；已有同名模块时不要重复注册。
        try engine.register(module: example)
        let url: URL
        #if DEBUG
        if ProcessInfo.processInfo.environment["URN_BUNDLE_MODE"] == "metro" {
            let text = ProcessInfo.processInfo.environment["URN_METRO_URL"]
                ?? "http://localhost:8081/index.container.bundle?platform=ios&dev=true&minify=false"
            guard let value = URL(string: text) else {
                throw URNContainerError("INVALID_BUNDLE_URL", "Metro 地址无效")
            }
            url = value
        } else {
            guard let value = Bundle.main.url(forResource: "main", withExtension: "jsbundle") else {
                throw URNContainerError("BUNDLE_MISSING", "找不到内置 bundle")
            }
            url = value
        }
        #else
        guard let value = Bundle.main.url(forResource: "main", withExtension: "jsbundle") else {
            throw URNContainerError("BUNDLE_MISSING", "找不到内置 bundle")
        }
        url = value
        #endif
        var config = try URNConfiguration(
            engine: engine, baselineId: "${baseline}", bundleURL: url,
            dependencyProvider: RCTAppDependencyProvider())
        // RN navigation.open 的目标权限由宿主逐页决定，不自动继承来源权限。
        config.navigationPageConfiguration = { _, _ in
            var target = URNPageConfiguration()
            target.allowedPermissions = []
            return target
        }
        coordinator = URNCoordinator(configuration: config)
    }

    func openHome(in navigation: UINavigationController) throws {
        var page = URNPageConfiguration()
        page.cleanup = { done in
            // 本示例无额外资源；业务取消和 UI dismiss 完成后再回调。
            done(.success(()))
        }
        let handle = try coordinator.open(featureId: "home", page: page) { _, result in
            if case .failure(let error) = result { print(error.localizedDescription) }
        }
        navigation.pushViewController(handle.viewController, animated: true)
    }
}

@MainActor
private final class URNExampleBridge: NSObject, BridgeModule {
    let moduleName = "URNExample"

    @objc func echo(_ session: BridgeSession) {
        let value = session.params?["value"] as? String ?? ""
        DispatchQueue.global(qos: .userInitiated).async {
            let result = value.uppercased()
            DispatchQueue.main.async { session.callback(["value": result]) }
        }
    }
}
`;
}
