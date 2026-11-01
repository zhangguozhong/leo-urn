#include <fbjni/fbjni.h>
#include <jsi/jsi.h>
#include <react/runtime/jni/JBindingsInstaller.h>

namespace jni = facebook::jni;
namespace react = facebook::react;
namespace jsi = facebook::jsi;

namespace {
// 参数必须保留实际 Java 类型，jobject 会让自动注册签名退化为 Object。
class JURNRuntimeState final : public jni::JavaClass<JURNRuntimeState> {
 public:
  static constexpr auto kJavaDescriptor = "Lcom/urn/sdk/runtime/URNRuntimeState;";
};

class URNBindingsInstaller final
    : public jni::HybridClass<URNBindingsInstaller, react::JBindingsInstaller> {
 public:
  static constexpr auto kJavaDescriptor =
      "Lcom/urn/sdk/runtime/URNBindingsInstaller;";

  explicit URNBindingsInstaller(jni::alias_ref<JURNRuntimeState> state)
      : state_(jni::make_global(state)) {}

  static jni::local_ref<jhybriddata> initHybrid(
      jni::alias_ref<jclass>, jni::alias_ref<JURNRuntimeState> state) {
    return makeCxxInstance(state);
  }

  react::ReactInstance::BindingsInstallFunc getBindingsInstallFunc() override {
    // 所有 JS 全局值在 bundle 求值前写入；每次实际 VM 创建都请求新的原生轮次。
    // RN 在安装期间持有当前 Hybrid 对象的全局引用。
    return [this](jsi::Runtime& runtime) {
      const auto method = state_->getClass()->getMethod<jni::JString()>("nextBootstrap");
      const auto text = method(state_)->toStdString();
      auto value = jsi::Value::createFromJsonUtf8(
          runtime, reinterpret_cast<const uint8_t*>(text.data()), text.size());
      auto object = value.asObject(runtime);
      runtime.global().setProperty(runtime, "__URNGeneration", object.getProperty(runtime, "generation"));
      runtime.global().setProperty(runtime, "__URNChannelBudget", object.getProperty(runtime, "budget"));
    };
  }

  static void registerNatives() {
    registerHybrid({makeNativeMethod("initHybrid", URNBindingsInstaller::initHybrid)});
  }

 private:
  friend HybridBase;
  jni::global_ref<JURNRuntimeState> state_;
};
} // namespace

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return jni::initialize(vm, [] { URNBindingsInstaller::registerNatives(); });
}
