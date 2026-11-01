cmake_minimum_required(VERSION 3.22.1)
project(urnbindings)

find_package(ReactAndroid REQUIRED CONFIG)
find_package(fbjni REQUIRED CONFIG)

add_library(urnbindings SHARED URNBindingsInstaller.cpp)
# NDK 27 默认仍可能生成4KiB LOAD段；自有JNI库与RN/Hermes统一支持16KiB系统。
target_link_options(urnbindings PRIVATE "-Wl,-z,max-page-size=16384")
# RN 的 BindingsInstaller JNI 头未随 Prefab 导出，使用锁定 RN 基线的同源头文件。
if(NOT EXISTS "${URN_REACT_NATIVE_DIR}/ReactAndroid/src/main/jni/react/runtime/jni/JBindingsInstaller.h")
  message(FATAL_ERROR "URN requires the matching React Native JNI source headers")
endif()
target_include_directories(urnbindings PRIVATE
  "${URN_REACT_NATIVE_DIR}/ReactAndroid/src/main/jni"
  "${URN_REACT_NATIVE_DIR}/ReactCommon"
)
include("${URN_REACT_NATIVE_DIR}/ReactCommon/cmake-utils/react-native-flags.cmake")
target_compile_reactnative_options(urnbindings PRIVATE)
target_link_libraries(urnbindings ReactAndroid::reactnative ReactAndroid::jsi fbjni::fbjni)
