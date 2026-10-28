#!/bin/bash
set -euo pipefail

fail() { printf 'URN: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 2 ]] || fail 'bundle-ios.sh 需要加载环境前确定的 App 与 React Native 目录'
readonly urn_app_root="$(cd -- "$1" && pwd -P)"
readonly urn_rn_root="$(cd -- "$2" && pwd -P)"
[[ "${CONFIGURATION_BUILD_DIR:-}" == /* ]] || fail '需要 Xcode 的绝对 CONFIGURATION_BUILD_DIR'
readonly urn_build_dir="$(cd -- "$CONFIGURATION_BUILD_DIR" && pwd -P)"
readonly urn_resources="${UNLOCALIZED_RESOURCES_FOLDER_PATH:-}"
[[ -n "$urn_resources" && "$urn_resources" != /* && "$urn_resources" == *.app ]] || fail '需要 Xcode 的相对 .app 资源目录'
IFS=/ read -r -a urn_parts <<< "$urn_resources"
for urn_part in "${urn_parts[@]}"; do
  [[ -n "$urn_part" && "$urn_part" != . && "$urn_part" != .. ]] || fail '非法 Xcode .app 资源目录'
done
readonly urn_destination="$urn_build_dir/$urn_resources/main.jsbundle"
readonly urn_configuration="${CONFIGURATION:-}"
readonly urn_platform="${PLATFORM_NAME:-}"
[[ "$urn_configuration" == Debug || "$urn_configuration" == Release ]] || fail '仅支持 Xcode Debug/Release'
[[ "$urn_platform" == iphoneos || "$urn_platform" == iphonesimulator ]] || fail '仅支持 iOS 设备或模拟器'
readonly urn_project_dir="${PROJECT_DIR:-}"
readonly urn_podfile_dir="${PODFILE_DIR:-}"
readonly urn_pods_root="${PODS_ROOT:-}"
readonly urn_use_hermes="${USE_HERMES:-true}"
readonly urn_hermes_cli="${HERMES_CLI_PATH:-}"
readonly urn_catalyst="${IS_MACCATALYST:-NO}"
readonly urn_path="$PATH"

check_node() {
  [[ "${NODE_BINARY:-}" == /* && -x "$NODE_BINARY" && ! -d "$NODE_BINARY" ]] || fail 'NODE_BINARY 必须为有效 Node 可执行文件的绝对路径'
  [[ "$("$NODE_BINARY" -p 'process.release.name' 2>/dev/null)" == node ]] || fail 'NODE_BINARY 不是有效 Node 运行时'
}
# 先删除旧 bundle；环境文件提前 exit/exec 或实际打包失败时不能留下可误验收的旧文件。
rm -f -- "$urn_build_dir/main.jsbundle" "$urn_destination"
unset NODE_OPTIONS NODE_ARGS BASH_ENV ENV
check_node
urn_resolved_rn="$("$NODE_BINARY" -p 'require("path").dirname(require.resolve("react-native/package.json", {paths: [process.argv[1]]}))' "$urn_app_root")"
[[ "$(cd -- "$urn_resolved_rn" && pwd -P)" == "$urn_rn_root" ]] || fail 'React Native 目录与选定 App 不匹配'
[[ -f "$urn_rn_root/scripts/xcode/with-environment.sh" && -f "$urn_rn_root/scripts/react-native-xcode.sh" ]] || fail 'React Native 标准打包脚本缺失'

(
  export PODFILE_DIR="$urn_podfile_dir" PODS_ROOT="$urn_pods_root" REACT_NATIVE_PATH="$urn_rn_root"
  # RN 0.87 官方加载器只执行 $1，不转发后续参数。传空命令，仅加载 .xcode.env/.local。
  # 子 shell 保证环境文件提前退出后，父 shell 仍检查本次生成的最终 bundle。
  source "$urn_rn_root/scripts/xcode/with-environment.sh" ""
  export PATH="$urn_path"
  unset SKIP_BUNDLING NODE_OPTIONS NODE_ARGS BASH_ENV ENV CDPATH
  unset CLI_PATH BUNDLE_COMMAND BUNDLE_CONFIG EXTRA_PACKAGER_ARGS CONFIG_JSON CONFIG_CMD
  unset SOURCEMAP_FILE COMPOSE_SOURCEMAP_PATH
  check_node
  export PROJECT_ROOT="$urn_app_root" ENTRY_FILE=index.container.js FORCE_BUNDLING=1 BUNDLE_NAME=main
  export CONFIGURATION="$urn_configuration" PLATFORM_NAME="$urn_platform"
  export CONFIGURATION_BUILD_DIR="$urn_build_dir" UNLOCALIZED_RESOURCES_FOLDER_PATH="$urn_resources"
  export PROJECT_DIR="$urn_project_dir" PODFILE_DIR="$urn_podfile_dir" PODS_ROOT="$urn_pods_root"
  export USE_HERMES="$urn_use_hermes" HERMES_CLI_PATH="$urn_hermes_cli" IS_MACCATALYST="$urn_catalyst"
  export REACT_NATIVE_PATH="$urn_rn_root" RN_ROOT="$urn_rn_root"
  /bin/bash "$urn_rn_root/scripts/react-native-xcode.sh"
)
[[ -s "$urn_destination" ]] || fail '本次打包未生成非空 main.jsbundle，拒绝旧产物'
