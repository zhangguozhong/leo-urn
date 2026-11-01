# JNI 必须能按固定名字找到运行时安装器和 bootstrap 回调。
-keep class com.urn.sdk.runtime.URNBindingsInstaller { *; }
-keep class com.urn.sdk.runtime.URNRuntimeState { *; }

# FragmentManager 在配置/进程恢复时反射创建容器。进程丢失后展示过期页并由宿主重开。
-keep public class com.urn.sdk.URNFragment { public <init>(); }
-keep public class com.urn.sdk.URNModalFragment { public <init>(); }
