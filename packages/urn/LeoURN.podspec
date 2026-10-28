require 'json'
metadata = JSON.parse(File.read(File.join(__dir__, 'package.json')))
Pod::Spec.new do |s|
  s.name = 'LeoURN'
  s.module_name = 'URN'
  s.version = metadata['version']
  s.summary = metadata['description']
  s.homepage = 'https://github.com/zhangguozhong/leo-urn'
  s.license = { :type => 'MIT', :file => 'LICENSE' }
  s.author = 'zhangguozhong'
  s.source = { :git => 'https://github.com/zhangguozhong/leo-urn.git', :tag => s.version.to_s }
  s.platform = :ios, '15.1'
  s.swift_version = '6.0'
  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  s.public_header_files = 'ios/ReactNative/URNReactHost.h'
  s.private_header_files = 'ios/Modules/*.h'
  s.dependency 'AerisHost/ReactNative', '= 0.25.0'
  s.dependency 'Aeris/UIKitContext', '= 0.25.0'
  install_modules_dependencies(s)
  # 本版本只验收此 RN 基线；Factory/Host API 不能静默跟随宿主升级。
  s.dependency 'React-Core', '= 0.87.0'
  s.dependency 'React-RCTAppDelegate', '= 0.87.0'
end
