import { templates } from './templates.mjs';
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const quoted = (value) => JSON.stringify(value);

/** 平台只替换原生组装，业务、Core、注册方式与唯一安装图继续共享。 */
export function androidTemplates({
  profile,
  name,
  mode,
  appFromHost,
  hostFromApp,
  appModule,
  applicationId,
}) {
  const files = templates({
    profile,
    name,
    iosProject: '',
    target: '',
    hostFromApp: '',
    appFromHost: '',
  });
  for (const key of Object.keys(files)) if (key.startsWith('ios-integration/')) delete files[key];
  const pkg = JSON.parse(files['package.json']);
  pkg.devDependencies['@react-native-community/cli-platform-android'] = '20.2.0';
  pkg.scripts['android:debug'] =
    'urn android-build --app . --variant debug --metro --install' +
    (mode === 'standalone' ? ' --launch' : '');
  pkg.scripts['android:release'] = 'urn android-build --app . --variant release';
  pkg.scripts['android:bundle'] = 'urn android-build --app . --variant release --bundle';
  pkg.scripts['android:probe'] = 'urn android-probe --app .';
  pkg.scripts['baseline:prepare'] = 'urn baseline --app .';
  pkg.scripts['baseline:check'] = 'urn check-baseline --app . --baseline android-baseline.json';
  files['package.json'] = json(pkg);
  files['urn.project.json'] = json({
    schemaVersion: 1,
    platform: 'android',
    mode,
    androidProject: hostFromApp,
    appModule,
    applicationId,
  });
  files['react-native.config.js'] =
    `module.exports = { project: { android: { sourceDir: ${quoted(hostFromApp)}, appName: ${quoted(appModule)} } } };\n`;
  const settings = settingsFragment(appFromHost);
  const gradle = appGradle(applicationId);
  const entryRoot = `${appModule}/src/main/java/${applicationId.replaceAll('.', '/')}`;
  const integration = 'android-integration/';
  files[`${integration}root.build.gradle.fragment`] =
    `// 与宿主根工程合并；AGP 版本须符合已验证基线。\nplugins {\n    id 'com.android.application' version '9.2.1' apply false\n    id 'com.android.library' version '9.2.1' apply false\n    id 'com.facebook.react.rootproject'\n}\nallprojects { repositories { google(); mavenCentral() } }\n`;
  files[`${integration}root.build.gradle.kts.fragment`] =
    `// 与宿主根工程合并，禁止重复声明同一个插件版本。\nplugins {\n    id("com.android.application") version "9.2.1" apply false\n    id("com.android.library") version "9.2.1" apply false\n    id("com.facebook.react.rootproject")\n}\nallprojects { repositories { google(); mavenCentral() } }\n`;
  files[`${integration}settings.gradle.fragment`] = settings;
  files[`${integration}settings.gradle.kts.fragment`] = kotlinSettingsFragment(appFromHost);
  files[`${integration}app.build.gradle.fragment`] = gradle;
  files[`${integration}app.build.gradle.kts.fragment`] = kotlinAppFragment(applicationId);
  files[`${integration}MainApplication.kt`] = application(applicationId, profile.baselineId);
  files[`${integration}MainActivity.kt`] = activity(applicationId);
  files[`${integration}AndroidManifest.xml.fragment`] = manifest(applicationId);
  if (mode === 'standalone') {
    files['android/settings.gradle'] =
      settings + `\nrootProject.name = ${quoted(name)}\ninclude ':${appModule}'\n`;
    files['android/build.gradle'] =
      `plugins {\n    id 'com.android.application' version '9.2.1' apply false\n    id 'com.android.library' version '9.2.1' apply false\n    id 'com.facebook.react.rootproject'\n}\nallprojects { repositories { google(); mavenCentral() } }\n`;
    files['android/gradle.properties'] =
      'android.useAndroidX=true\norg.gradle.jvmargs=-Xmx4g -Dfile.encoding=UTF-8\nnewArchEnabled=true\nhermesEnabled=true\nreactNativeArchitectures=arm64-v8a,x86_64\n';
    files[`android/${appModule}/build.gradle`] = gradle;
    files[`android/${entryRoot}/MainApplication.kt`] = application(
      applicationId,
      profile.baselineId,
    );
    files[`android/${entryRoot}/MainActivity.kt`] = activity(applicationId);
    files[`android/${appModule}/src/main/AndroidManifest.xml`] = manifest(applicationId);
    files[`android/${appModule}/src/debug/AndroidManifest.xml`] =
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools"><application android:usesCleartextTraffic="true" tools:replace="android:usesCleartextTraffic" /></manifest>\n';
    files[`android/${appModule}/src/main/res/values/ids.xml`] =
      '<resources><item name="urn_container" type="id" /></resources>\n';
    files[`android/${appModule}/proguard-rules.pro`] =
      '# RN/URN/Aeris 的 consumer rules 由对应库提供，业务注解方法规则由 Aeris 保留。\n';
    files[`android/${appModule}/src/main/assets/.gitkeep`] = '';
  }
  files['README.md'] = readme({ name, mode, appModule, hostFromApp });
  return files;
}

function nodeResolve(appRelative, kotlin = false) {
  const expression =
    "require('path').dirname(require('path').dirname(require.resolve('react-native/package.json',{paths:[process.argv[1]]})))";
  if (kotlin)
    return `val urnApp = file(${quoted(appRelative)}).canonicalFile\nval urnModules = providers.exec { commandLine("node", "-p", ${quoted(expression)}, urnApp.absolutePath) }.standardOutput.asText.get().trim()\n`;
  return `def urnApp = file(${quoted(appRelative)}).canonicalFile\ndef urnModules = providers.exec { commandLine('node', '-p', ${quoted(expression)}, urnApp.absolutePath) }.standardOutput.asText.get().trim()\n`;
}
function settingsFragment(appRelative) {
  return `// 合并至宿主 settings；pluginManagement 和 plugins 必须按 Gradle 要求放在最前面。\npluginManagement {\n${nodeResolve(appRelative)}    includeBuild("$urnModules/@react-native/gradle-plugin")\n    repositories { google(); mavenCentral(); gradlePluginPortal() }\n}\nplugins { id 'com.facebook.react.settings' }\n${nodeResolve(appRelative)}extensions.configure(com.facebook.react.ReactSettingsExtension) { extension ->\n    extension.autolinkLibrariesFromCommand(['node', "$urnModules/@react-native-community/cli/build/bin.js", 'config'], urnApp, layout.rootDirectory.dir(${quoted(appRelative)}).files('package.json', 'package-lock.json', 'react-native.config.js'))\n}\ninclude ':aeris'\nproject(':aeris').projectDir = new File(urnApp, '.urn/aeris/native/android/aeris')\nincludeBuild("$urnModules/@react-native/gradle-plugin")\ngradle.beforeProject { p ->\n    p.ext.urnNodeModules = urnModules\n    p.ext.aerisNodeModulesDir = urnModules\n    p.ext.urnAppRoot = urnApp.absolutePath\n}\n`;
}
function kotlinSettingsFragment(appRelative) {
  return `// 与原 settings.gradle.kts 合并，保留原有模块和仓库。\npluginManagement {\n${nodeResolve(appRelative, true)}    includeBuild("$urnModules/@react-native/gradle-plugin")\n    repositories { google(); mavenCentral(); gradlePluginPortal() }\n}\nplugins { id("com.facebook.react.settings") }\n${nodeResolve(appRelative, true)}extensions.configure<com.facebook.react.ReactSettingsExtension> {\n    autolinkLibrariesFromCommand(listOf("node", "$urnModules/@react-native-community/cli/build/bin.js", "config"), urnApp, layout.rootDirectory.dir(${quoted(appRelative)}).files("package.json", "package-lock.json", "react-native.config.js"))\n}\ninclude(":aeris")\nproject(":aeris").projectDir = File(urnApp, ".urn/aeris/native/android/aeris")\nincludeBuild("$urnModules/@react-native/gradle-plugin")\ngradle.beforeProject {\n    extensions.extraProperties["urnNodeModules"] = urnModules\n    extensions.extraProperties["aerisNodeModulesDir"] = urnModules\n    extensions.extraProperties["urnAppRoot"] = urnApp.absolutePath\n}\n`;
}
function appGradle(id) {
  return `plugins { id 'com.android.application'; id 'com.facebook.react' }\ndef urnModules = rootProject.findProperty('urnNodeModules').toString()\ndef urnApp = file(rootProject.findProperty('urnAppRoot'))\ndef metro = providers.gradleProperty('urnMetro').orElse('false').get().toBoolean()\nreact {\n    root = urnApp\n    reactNativeDir = file("$urnModules/react-native")\n    codegenDir = file("$urnModules/@react-native/codegen")\n    cliFile = file("$urnModules/react-native/cli.js")\n    hermesCommand = "$urnModules/hermes-compiler/hermesc/%OS-BIN%/hermesc"\n    entryFile = new File(urnApp, 'index.container.js')\n    bundleAssetName = 'index.android.bundle'\n    debuggableVariants = metro ? ['debug'] : []\n    autolinkLibrariesWithApp()\n}\nandroid {\n    namespace ${quoted(id)}\n    compileSdk 37\n    ndkVersion '27.1.12297006'\n    defaultConfig { applicationId ${quoted(id)}; minSdk 24; targetSdk 36; versionCode 1; versionName '1.0' }\n    buildFeatures { buildConfig true }\n    compileOptions { sourceCompatibility JavaVersion.VERSION_17; targetCompatibility JavaVersion.VERSION_17 }\n    buildTypes {\n        debug { buildConfigField 'boolean', 'URN_METRO', metro.toString() }\n        release {\n            buildConfigField 'boolean', 'URN_METRO', 'false'\n            minifyEnabled true\n            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'\n            // 宿主从环境/CI注入自己的 signingConfig，模板不携带签名或密码。\n        }\n    }\n    packaging { resources.excludes += ['META-INF/AL2.0', 'META-INF/LGPL2.1'] }\n}\ndependencies {\n    implementation 'com.facebook.react:react-android:0.87.0'\n    implementation 'com.facebook.react:hermes-android'\n    implementation 'androidx.fragment:fragment-ktx:1.8.9'\n}\n`;
}
function kotlinAppFragment(id) {
  return `// 与现有 app/build.gradle.kts 合并，不删除业务依赖、签名和 buildTypes。\nplugins { id("com.facebook.react") }\nval urnModules = rootProject.property("urnNodeModules").toString()\nval urnApp = file(rootProject.property("urnAppRoot"))\nval metro = providers.gradleProperty("urnMetro").orElse("false").get().toBoolean()\nreact {\n    root.set(urnApp)\n    reactNativeDir.set(file("$urnModules/react-native"))\n    codegenDir.set(file("$urnModules/@react-native/codegen"))\n    cliFile.set(file("$urnModules/react-native/cli.js"))\n    hermesCommand.set("$urnModules/hermes-compiler/hermesc/%OS-BIN%/hermesc")\n    entryFile.set(File(urnApp, "index.container.js"))\n    bundleAssetName.set("index.android.bundle")\n    debuggableVariants.set(if (metro) listOf("debug") else emptyList())\n    autolinkLibrariesWithApp()\n}\nandroid {\n    namespace = ${quoted(id)}\n    compileSdk = 37\n    ndkVersion = "27.1.12297006"\n    defaultConfig { minSdk = 24; targetSdk = 36 }\n    buildFeatures { buildConfig = true }\n    buildTypes {\n        getByName("debug") { buildConfigField("boolean", "URN_METRO", metro.toString()) }\n        getByName("release") { buildConfigField("boolean", "URN_METRO", "false"); isMinifyEnabled = true; proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro") }\n    }\n}\ndependencies {\n    implementation("com.facebook.react:react-android:0.87.0")\n    implementation("com.facebook.react:hermes-android")\n    implementation("androidx.fragment:fragment-ktx:1.8.9")\n}\n`;
}
function application(id, baseline) {
  return `package ${id}\n\nimport android.app.Application\nimport android.os.Handler\nimport android.os.Looper\nimport com.facebook.react.PackageList\nimport com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative\nimport com.google.gson.JsonObject\nimport com.aeris.sdk.*\nimport com.urn.sdk.*\n\n/** 宿主强持有一个 Coordinator；业务 Bridge 按独立 Session 回传。 */\nclass MainApplication : Application(), URNCoordinatorOwner {\n    override lateinit var urnCoordinator: URNCoordinator\n        private set\n    override fun onCreate() {\n        super.onCreate()\n        loadReactNative(this)\n        val engine = BridgeEngine.shared\n        engine.register(ExampleBridge())\n        urnCoordinator = URNCoordinator(this, URNConfiguration(\n            engine = engine, reactPackages = PackageList(this).packages,\n            baselineId = ${quoted(baseline)}, developerSupport = BuildConfig.URN_METRO,\n            navigationPagePolicy = { _, _ -> URNPagePolicy() },\n            cleanup = { _, done -> done(Result.success(Unit)) },\n        ))\n    }\n}\n\nprivate class ExampleBridge : BridgeModule {\n    override val moduleName = "URNExample"\n    @BridgeMethod fun echo(session: BridgeSession) {\n        val value = session.params.get("value")?.asString.orEmpty()\n        Handler(Looper.getMainLooper()).post {\n            session.callback(JsonObject().apply { addProperty("value", value.uppercase()) })\n        }\n    }\n}\n`;
}
function activity(id) {
  return `package ${id}\n\nimport android.content.Intent\nimport android.content.res.Configuration\nimport android.os.Bundle\nimport android.widget.FrameLayout\nimport androidx.fragment.app.FragmentActivity\nimport androidx.activity.OnBackPressedCallback\nimport com.facebook.react.modules.core.DefaultHardwareBackBtnHandler\nimport com.facebook.react.modules.core.PermissionAwareActivity\nimport com.facebook.react.modules.core.PermissionListener\nimport com.urn.sdk.*\n\nclass MainActivity : FragmentActivity(), URNCoordinatorOwner, DefaultHardwareBackBtnHandler, PermissionAwareActivity {\n    override val urnCoordinator get() = (application as MainApplication).urnCoordinator\n    override fun onCreate(savedInstanceState: Bundle?) {\n        super.onCreate(savedInstanceState)\n        setContentView(FrameLayout(this).apply { id = R.id.urn_container })\n        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {\n            override fun handleOnBackPressed() {\n                if (!urnCoordinator.onBackPressed()) invokeDefaultOnBackPressed()\n            }\n        })\n        if (savedInstanceState == null || urnCoordinator.pageCount == 0) {\n            // 进程重启重新打开入口，不复活内存中已丢失的旧 Session/callback。\n            // 只清理本容器拥有的旧导航记录和Modal，保留宿主其它业务Fragment。\n            while (supportFragmentManager.backStackEntryCount > 0) {\n                val top = supportFragmentManager.getBackStackEntryAt(supportFragmentManager.backStackEntryCount - 1)\n                if (top.name?.startsWith("urn.navigation.") != true) break\n                supportFragmentManager.popBackStackImmediate()\n            }\n            supportFragmentManager.fragments.filterIsInstance<URNModalFragment>().forEach { it.dismissNow() }\n            supportFragmentManager.fragments.filterIsInstance<URNFragment>().forEach {\n                supportFragmentManager.beginTransaction().remove(it).commitNow()\n            }\n            val page = urnCoordinator.open("home")\n            supportFragmentManager.beginTransaction().add(R.id.urn_container, page.fragment, "urn.home").commitNow()\n        }\n    }\n    override fun onResume() { super.onResume(); urnCoordinator.onHostResume(this, this) }\n    override fun onPause() { urnCoordinator.onHostPause(this); super.onPause() }\n    override fun onDestroy() { if (isFinishing) urnCoordinator.closeAll(); urnCoordinator.onHostDestroy(this); super.onDestroy() }\n    override fun invokeDefaultOnBackPressed() {\n        if (URNModalFragment.dispatchDefaultBack(supportFragmentManager)) return\n        if (supportFragmentManager.isStateSaved) return\n        if (supportFragmentManager.backStackEntryCount > 0) supportFragmentManager.popBackStackImmediate() else finish()\n    }\n    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) { super.onActivityResult(requestCode, resultCode, data); urnCoordinator.onActivityResult(this, requestCode, resultCode, data) }\n    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) { super.onRequestPermissionsResult(requestCode, permissions, grantResults); urnCoordinator.onRequestPermissionsResult(this, requestCode, permissions, grantResults) }\n    override fun requestPermissions(permissions: Array<String>, requestCode: Int, listener: PermissionListener?) {\n        if (listener == null) super.requestPermissions(permissions, requestCode)\n        else urnCoordinator.requestPermissions(this, permissions, requestCode, listener)\n    }\n    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); urnCoordinator.onNewIntent(intent) }\n    override fun onWindowFocusChanged(hasFocus: Boolean) { super.onWindowFocusChanged(hasFocus); urnCoordinator.onWindowFocusChanged(hasFocus) }\n    override fun onConfigurationChanged(newConfig: Configuration) { super.onConfigurationChanged(newConfig); urnCoordinator.onConfigurationChanged(this, newConfig) }\n    override fun onUserLeaveHint() { super.onUserLeaveHint(); urnCoordinator.onUserLeaveHint(this) }\n}\n`;
}
function manifest(id) {
  return `<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n    <uses-permission android:name="android.permission.INTERNET" />\n    <application android:name="${id}.MainApplication" android:label="URN" android:theme="@android:style/Theme.Material.Light.NoActionBar" android:usesCleartextTraffic="false" android:allowBackup="false">\n        <activity android:name="${id}.MainActivity" android:exported="true" android:enableOnBackInvokedCallback="true">\n            <intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter>\n        </activity>\n    </application>\n</manifest>\n`;
}
function readme({ name, mode, appModule, hostFromApp }) {
  return `# ${name}\n\nAndroid ${mode === 'standalone' ? '独立调试壳' : '嵌入已有原生App'}，RN0.87.0/React19.2.3，API24+、JDK17、Gradle9.4.1、AGP9.2.1、compileSdk37、NDK27.1.12297006。\n\n1. 本工程运行 npm run prepare:urn，首次 npm install，后续 npm ci。Android profile 必须包含本版本 Android Core/RN/URN，旧的公开 iOS profile 不能冒充 Android 支持。只有本工程一份 node_modules；业务包使用 peerDependencies。\n2. ${mode === 'standalone' ? 'android/ 是可独立运行的原生调试壳。' : '将 android-integration/ 的Groovy或Kotlin片段合并至真实宿主，保留原App模块/仓库/签名；MainApplication示例整合入现有Application，不替换业务Application。'}\n3. 已安装Android SDK的环境运行 npm start；另一个终端 adb reverse tcp:8081 tcp:8081，然后 npm run android:debug。Android Studio从 ${hostFromApp} 打开同一个Gradle工程，并设置 -PurnMetro=true。\n4. npm run android:probe 捕获真实Gradle工具链，再 npm run baseline:prepare 审阅锁定基线。提交package-lock和基线，.urn缓存由prepare恢复。\n5. npm run android:release 生成R8离线Release APK；npm run android:bundle 生成AAB。构建不依赖Metro。正式签名由宿主/CI注入keystore，模板没有密钥，不会自动上传。\n6. 模块 ${appModule} 使用唯一React bundle任务，assets/index.android.bundle由Hermes生成；资源由RN Gradle插件收集。urn android-audit 检查bundle摘要、ABI/JNI/资源，签名/真机和商店发布仍执行项目自己的流程。\n7. 页面通过 environment.navigation.open/close 返回结果，宿主配置 navigator/pageUI/导航目标权限。完整关闭应等真实cleanup与Surface/Host销毁完成；隐藏/后台和手势取消不关闭连接。\n\n命令仅生成本工程/接入文件，不修改已有宿主。路径必须使用英文字母、数字、空格、横线或下划线，不支持中文目录。完整进程重启走安全重新打开入口的策略，不恢复旧callback。\n`;
}
