#import "URNReactHost.h"
#import "../Modules/URNChannelBudgetDefaults.h"
#import "../Modules/URNMessageInbox.h"
#import "../Modules/URNMessageOutbox.h"
#import "../Modules/URNModules.h"
#import "../Modules/URNPageCommandQueue.h"
#import <React-RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>
#import <React-RCTAppDelegate/RCTReactNativeFactory.h>
#import <React/RCTDevMenu.h>
#import <React/RCTReloadCommand.h>
#import <React/RCTSurfaceHostingProxyRootView.h>
#import <React/RCTSurfacePresenter.h>
#import <ReactCommon/RCTHost.h>
#include <cstring>
#import <jsi/jsi.h>
#import <react/runtime/JSRuntimeFactoryCAPI.h>

@interface URNReactHost () <URNModuleSink>
@property (atomic, copy, readwrite, nullable) NSString *generation;
- (void)initializedInRuntime:(facebook::jsi::Runtime &)runtime;
- (void)runtimeDestroyed;
- (void)reloadRequested;
- (void)pollStop;
@end

namespace {
// 仅由对应 JSI global 持有；析构确认旧 Runtime 已真正释放，而非仅关闭连接。
class URNRuntimeSentinel final : public facebook::jsi::HostObject {
  public:
    explicit URNRuntimeSentinel(URNReactHost *owner) : owner_(owner) {}
    ~URNRuntimeSentinel() override {
        [owner_ runtimeDestroyed];
    }

  private:
    __weak URNReactHost *owner_;
};
} // namespace

@interface URNManagedHost : RCTHost <RCTReloadListener>
@property (nonatomic, copy) dispatch_block_t managedReload;
@end
@implementation URNManagedHost
- (void)didReceiveReloadCommand {
    // RN 在持有 Reload listener 锁时调用此方法；绝不能同步构造下一代 Host。
    dispatch_block_t reload = self.managedReload;
    dispatch_async(dispatch_get_main_queue(), ^{
        if (reload)
            reload();
    });
}
@end

@interface URNFactoryDelegate : RCTDefaultReactNativeFactoryDelegate
@property (nonatomic, weak) URNReactHost *owner;
@property (nonatomic, strong) NSURL *source;
@property (atomic, copy) NSString *generation;
@property (atomic, weak) URNChannelModule *channelModule;
@property (atomic, weak) URNLifecycleModule *lifecycleModule;
@end
@implementation URNFactoryDelegate
- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge {
    return self.source;
}
- (NSURL *)bundleURL {
    return self.source;
}
- (id<RCTModuleProvider>)getModuleProvider:(const char *)name {
    if (std::strcmp(name, "URNChannel") == 0 || std::strcmp(name, "URNLifecycle") == 0)
        return nil;
    return [super getModuleProvider:name];
}
- (Class)getModuleClassFromName:(const char *)name {
    if (std::strcmp(name, "URNChannel") == 0)
        return URNChannelModule.class;
    if (std::strcmp(name, "URNLifecycle") == 0)
        return URNLifecycleModule.class;
    return [super getModuleClassFromName:name];
}
- (id<RCTTurboModule>)getModuleInstanceFromClass:(Class)moduleClass {
    if (moduleClass == URNChannelModule.class) {
        URNChannelModule *module = [[URNChannelModule alloc] initWithSink:self.owner
                                                               generation:self.generation];
        self.channelModule = module;
        return module;
    }
    if (moduleClass == URNLifecycleModule.class) {
        URNLifecycleModule *module = [[URNLifecycleModule alloc] initWithSink:self.owner
                                                                   generation:self.generation];
        self.lifecycleModule = module;
        return module;
    }
    return [super getModuleInstanceFromClass:moduleClass];
}
- (void)hostDidStart:(RCTHost *)host {
}
- (void)host:(RCTHost *)host didInitializeRuntime:(facebook::jsi::Runtime &)runtime {
    [self.owner initializedInRuntime:runtime];
}
@end

@implementation URNReactHost {
    URNPageCommandQueue *_commandQueue;
    NSURL *_bundleURL;
    id _dependencyProvider;
    URNFactoryDelegate *_delegate;
    RCTReactNativeFactory *_factory;
    RCTScheduler *_drainingScheduler;
    URNMessageInbox *_inbox;
    URNMessageOutbox *_outbox;
    NSMutableSet<NSString *> *_signals;
    NSMutableDictionary<NSString *, NSString *> *_pendingClose;
    BOOL _started, _stopping, _runtimeDestroyed, _lifecycleReady, _booted, _bootScheduled;
    NSUInteger _moduleCount;
    __weak id _retiredFactory;
    __weak id _retiredHost;
    NSTimeInterval _stopDeadline;
    NSMutableArray<void (^)(NSError *)> *_stopCallbacks;
}
@synthesize generation = _generation;

- (instancetype)initWithBundleURL:(NSURL *)bundleURL dependencyProvider:(id)dependencyProvider {
    return [self initWithBundleURL:bundleURL
                dependencyProvider:dependencyProvider
                     channelBudget:URNDefaultChannelBudget()];
}
- (instancetype)initWithBundleURL:(NSURL *)bundleURL
               dependencyProvider:(id)dependencyProvider
                    channelBudget:(NSDictionary<NSString *, NSNumber *> *)channelBudget {
    if ((self = [super init])) {
        _channelBudget = [channelBudget copy];
        _bundleURL = bundleURL;
        _dependencyProvider = dependencyProvider;
        _signals = [NSMutableSet new];
        _commandQueue = [URNPageCommandQueue new];
        _pendingClose = [NSMutableDictionary new];
        _stopCallbacks = [NSMutableArray new];
        _inbox = [[URNMessageInbox alloc] initWithChannelBudget:_channelBudget];
        _outbox = [[URNMessageOutbox alloc] initWithChannelBudget:_channelBudget];
        if (!_inbox || !_outbox)
            return nil;
        __weak URNReactHost *weakSelf = self;
        _outbox.delivery = ^(NSString *generation, NSString *channel, NSString *deliveryId,
                             NSString *kind, NSString *message) {
            URNReactHost *self = weakSelf;
            if (!self || self->_stopping)
                return;
            NSDictionary *event = @{
                @"runtimeGeneration" : generation,
                @"channelId" : channel,
                @"deliveryId" : deliveryId,
                [kind isEqual:@"close"] ? @"reason" : @"message" : message
            };
            if ([kind isEqual:@"close"])
                [self->_delegate.lifecycleModule emitOnCloseRequested:event];
            else if ([kind isEqual:@"pageEvent"])
                [self->_delegate.lifecycleModule emitOnPageEvent:event];
            else
                [self->_delegate.channelModule emitOnMessage:event];
        };
        _outbox.fault = ^(NSString *channel) {
            URNReactHost *self = weakSelf;
            if (self && !self->_stopping && self.onFault)
                self.onFault(channel, @"BACKPRESSURE", @"Native到JS出站预算耗尽");
        };
        _inbox.delivery = ^(NSString *generation, NSString *channel, NSString *message) {
            URNReactHost *self = weakSelf;
            if (self && !self->_stopping && self.onMessage)
                self.onMessage(generation, channel, message);
        };
        _inbox.fault = ^(NSString *generation, NSString *channel, NSString *reason) {
            URNReactHost *self = weakSelf;
            if (self && !self->_stopping && self.onFault)
                self.onFault(channel, @"BACKPRESSURE", reason);
        };
    }
    return self;
}
- (void)start {
    @autoreleasepool {
        if (_started || _stopping)
            return;
        _started = YES;
        _delegate = [URNFactoryDelegate new];
        _delegate.owner = self;
        _delegate.source = _bundleURL;
        _delegate.generation = @"";
        _delegate.dependencyProvider = _dependencyProvider;
        _factory = [[RCTReactNativeFactory alloc] initWithDelegate:_delegate];
        URNFactoryDelegate *delegate = _delegate;
        __weak URNReactHost *weakSelf = self;
        URNManagedHost *host = [[URNManagedHost alloc]
            initWithBundleURLProvider:^NSURL * {
                return delegate.source;
            }
            hostDelegate:delegate
            turboModuleManagerDelegate:(id<RCTTurboModuleManagerDelegate>)_factory
            jsEngineProvider:^std::shared_ptr<facebook::react::JSRuntimeFactory> {
                auto runtimeFactory = [delegate createJSRuntimeFactory];
                return std::shared_ptr<facebook::react::JSRuntimeFactory>(
                    reinterpret_cast<facebook::react::JSRuntimeFactory *>(runtimeFactory),
                    &js_runtime_factory_destroy);
            }
            launchOptions:nil
            bundleConfiguration:_factory.bundleConfiguration
            devMenuConfiguration:[RCTDevMenuConfiguration defaultConfiguration]];
        host.managedReload = ^{
            [weakSelf reloadRequested];
        };
        _factory.rootViewFactory.reactHost = host;
        [_factory.rootViewFactory
            initializeReactHostWithLaunchOptions:nil
                             bundleConfiguration:_factory.bundleConfiguration
                            devMenuConfiguration:[RCTDevMenuConfiguration defaultConfiguration]];
        [host start];
    }
}
- (void)initializedInRuntime:(facebook::jsi::Runtime &)runtime {
    NSString *generation = NSUUID.UUID.UUIDString;
    self.generation = generation;
    _delegate.generation = generation;
    [_inbox activateGeneration:generation];
    [_outbox activateGeneration:generation];
    runtime.global().setProperty(
        runtime, "__URNGeneration",
        facebook::jsi::String::createFromUtf8(runtime, generation.UTF8String));
    facebook::jsi::Object budget(runtime);
    for (NSString *key in _channelBudget) {
        budget.setProperty(runtime, key.UTF8String,
                           facebook::jsi::Value(_channelBudget[key].doubleValue));
    }
    runtime.global().setProperty(runtime, "__URNChannelBudget", std::move(budget));
    runtime.global().setProperty(runtime, "__URNRuntimeSentinel",
                                 facebook::jsi::Object::createFromHostObject(
                                     runtime, std::make_shared<URNRuntimeSentinel>(self)));
    __weak URNReactHost *weakSelf = self;
    dispatch_async(dispatch_get_main_queue(), ^{
        URNReactHost *self = weakSelf;
        if (self && !self->_stopping && self.onInitialized)
            self.onInitialized(generation);
        [self pollStop];
    });
}
- (void)bootGeneration:(NSString *)generation {
    if (![generation isEqual:self.generation])
        return;
    @synchronized(self) {
        if (_bootScheduled)
            return;
        _bootScheduled = YES;
    }
    __weak URNReactHost *weakSelf = self;
    dispatch_async(dispatch_get_main_queue(), ^{
        URNReactHost *self = weakSelf;
        if (!self || self->_stopping || self->_booted)
            return;
        self->_booted = YES;
        self->_lifecycleReady = YES;
        [self flushCloseRequests];
        if (self.onBooted)
            self.onBooted();
    });
}
- (BOOL)registerChannel:(NSString *)channel {
    if (_stopping || ![_inbox registerChannel:channel])
        return NO;
    if ([_outbox registerChannel:channel])
        return YES;
    [_inbox retireChannel:channel];
    return NO;
}
- (NSDictionary<NSString *, NSNumber *> *)messageQueueSnapshot {
    NSMutableDictionary *snapshot = [[_inbox snapshot] mutableCopy];
    NSDictionary *outbound = [_outbox snapshot];
    for (NSString *key in outbound)
        snapshot[[@"outbound." stringByAppendingString:key]] = outbound[key];
    return snapshot;
}
- (void)retireChannel:(NSString *)channel {
    [_inbox retireChannel:channel];
    [_outbox retireChannel:channel];
    [_pendingClose removeObjectForKey:channel];
}
- (UIView *)rootForFeature:(NSString *)feature
                    params:(NSDictionary *)params
                    pageId:(NSString *)pageId
                   channel:(NSString *)channel
                  baseline:(NSString *)baseline {
    @autoreleasepool {
        NSString *generation = self.generation;
        if (_stopping || !generation || ![_inbox containsGeneration:generation channel:channel])
            return nil;
        NSDictionary *properties = @{
            @"featureId" : feature,
            @"params" : params,
            @"containerContext" : @{
                @"pageId" : pageId,
                @"channelId" : channel,
                @"runtimeGeneration" : generation,
                @"baselineId" : baseline
            }
        };
        return [_factory.rootViewFactory viewWithModuleName:@"URNRoot"
                                          initialProperties:properties
                                              launchOptions:nil];
    }
}
- (void)receiveGeneration:(NSString *)generation
                  channel:(NSString *)channel
                  message:(NSString *)message {
    [_inbox enqueueGeneration:generation channel:channel message:message];
}
- (void)emitMessage:(NSString *)message channel:(NSString *)channel {
    if (!_stopping)
        [_outbox enqueueChannel:channel kind:@"message" message:message control:NO];
}
- (void)emitPageEvent:(NSString *)message channel:(NSString *)channel {
    if (!_stopping)
        [_outbox enqueueChannel:channel kind:@"pageEvent" message:message control:NO];
}
- (void)acknowledgeGeneration:(NSString *)generation
                      channel:(NSString *)channel
                   deliveryId:(NSString *)deliveryId {
    if (generation.length > 256 || channel.length > 256 || deliveryId.length > 80)
        return;
    // 不检查 Inbox 活动表，退役帧也需要确认；Outbox 自行校验轮次及在途身份。
    [_outbox acknowledgeGeneration:generation channel:channel deliveryId:deliveryId];
}
- (void)command:(NSString *)command
     generation:(NSString *)generation
        channel:(NSString *)channel
      requestId:(NSString *)requestId
        payload:(NSString *)payload {
    if (![_inbox containsGeneration:generation channel:channel] || requestId.length > 80 ||
        command.length > 16 || payload.length > 16384 ||
        [payload lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 16384)
        return;
    generation = [generation copy];
    channel = [channel copy];
    command = [command copy];
    requestId = [requestId copy];
    payload = [payload copy];
    __weak URNReactHost *weakSelf = self;
    [_commandQueue submitChannel:channel
        command:command
        requestId:requestId
        work:^{
            URNReactHost *self = weakSelf;
            if (!self || self->_stopping ||
                ![self->_inbox containsGeneration:generation channel:channel])
                return;
            if (self.onCommand)
                self.onCommand(channel, command, requestId, payload);
        }
        rejected:^{
            URNReactHost *self = weakSelf;
            if (!self || self->_stopping ||
                ![self->_inbox containsGeneration:generation channel:channel])
                return;
            if (self.onFault)
                self.onFault(channel, @"BACKPRESSURE", @"页面导航命令预算耗尽");
        }];
}
- (void)requestClose:(NSString *)channel reason:(NSString *)reason {
    if (![_inbox containsGeneration:self.generation channel:channel])
        return;
    _pendingClose[channel] = [reason substringToIndex:MIN(reason.length, 256)];
    [self flushCloseRequests];
}
- (void)flushCloseRequests {
    @autoreleasepool {
        // 首个实际生命周期调用证明 JS 已安装事件监听，不能在模块构造时直接发事件。
        if (!_lifecycleReady || _stopping)
            return;
        for (NSString *channel in _pendingClose.allKeys) {
            [_outbox enqueueChannel:channel
                               kind:@"close"
                            message:_pendingClose[channel]
                            control:YES];
            [_pendingClose removeObjectForKey:channel];
        }
    }
}
- (void)lifecycle:(NSString *)event
       generation:(NSString *)generation
          channel:(NSString *)channel
             code:(NSString *)code
          message:(NSString *)message {
    if (![_inbox containsGeneration:generation channel:channel])
        return;
    NSString *key = [NSString stringWithFormat:@"%@:%@", channel, event];
    @synchronized(_signals) {
        // 每个原生登记的通道每类信号只接纳一次，独立控制队列不会被业务消息挤满。
        if ([_signals containsObject:key])
            return;
        [_signals addObject:key];
    }
    code = [code substringToIndex:MIN(code.length, 80)];
    message = [message substringToIndex:MIN(message.length, 256)];
    __weak URNReactHost *weakSelf = self;
    dispatch_async(dispatch_get_main_queue(), ^{
        URNReactHost *self = weakSelf;
        if (!self || self->_stopping ||
            ![self->_inbox containsGeneration:generation channel:channel])
            return;
        self->_lifecycleReady = YES;
        [self flushCloseRequests];
        if (self.onLifecycle)
            self.onLifecycle(channel, event, code, message);
    });
}
- (void)moduleCreated {
    @synchronized(self) {
        _moduleCount++;
    }
}
- (void)moduleDestroyed {
    @synchronized(self) {
        if (_moduleCount)
            _moduleCount--;
    }
    __weak URNReactHost *weakSelf = self;
    dispatch_async(dispatch_get_main_queue(), ^{
        [weakSelf pollStop];
    });
}
- (void)moduleInvalidated:(NSString *)module generation:(NSString *)generation {
    __weak URNReactHost *weakSelf = self;
    dispatch_async(dispatch_get_main_queue(), ^{
        URNReactHost *self = weakSelf;
        if (self && !self->_stopping && [self.generation isEqual:generation] && self.onFault)
            self.onFault(nil, @"RUNTIME_DISCONNECTED", @"React Native 模块意外断开");
    });
}
- (void)runtimeDestroyed {
    __weak URNReactHost *weakSelf = self;
    dispatch_async(dispatch_get_main_queue(), ^{
        URNReactHost *self = weakSelf;
        if (self) {
            self->_runtimeDestroyed = YES;
            // JSI 析构意味着旧 JS 渲染任务已结束，此时再释放调度对象。
            self->_drainingScheduler = nil;
        }
        [self pollStop];
    });
}
- (void)reloadRequested {
    if (!_stopping && self.onReloadRequested)
        self.onReloadRequested();
}
- (void)detachRoot:(UIView *)root {
    @autoreleasepool {
        if ([root isKindOfClass:RCTSurfaceHostingProxyRootView.class])
            [((RCTSurfaceHostingProxyRootView *)root).surface stop];
        [root removeFromSuperview];
    }
}
- (void)stopWithCompletion:(void (^)(NSError *))completion {
    [_stopCallbacks addObject:[completion copy]];
    if (_stopping) {
        [self pollStop];
        return;
    }
    _stopping = YES;
    [_inbox invalidate];
    [_outbox invalidate];
    @autoreleasepool {
        if (_lifecycleReady && self.generation)
            [_delegate.channelModule emitOnDisconnect:@{
                @"runtimeGeneration" : self.generation,
                @"code" : @"RUNTIME_CLOSED",
                @"message" : @"容器运行时关闭"
            }];
        // RN 0.87 的待执行渲染任务可能保留 Scheduler delegate 的裸指针。
        // Host invalidate 会先 suspend Presenter；保留 Scheduler 到真实 JSI 析构，
        // 避免其先析构、JS 队列随后访问已释放的 delegate。不要用固定延时替代屏障。
        _drainingScheduler = _factory.rootViewFactory.reactHost.surfacePresenter.scheduler;
        _retiredFactory = _factory;
        _retiredHost = _factory.rootViewFactory.reactHost;
        _factory.rootViewFactory.reactHost = nil;
        _factory = nil;
        _delegate = nil;
        _dependencyProvider = nil;
    }
    _stopDeadline = NSProcessInfo.processInfo.systemUptime + 30;
    if (!_started)
        _runtimeDestroyed = YES;
    [self pollStop];
}
- (void)pollStop {
    @autoreleasepool {
        if (!_stopping || !_stopCallbacks.count)
            return;
        NSUInteger modules;
        @synchronized(self) {
            modules = _moduleCount;
        }
        BOOL released = !_retiredHost && !_retiredFactory && _runtimeDestroyed && modules == 0;
        BOOL expired = NSProcessInfo.processInfo.systemUptime >= _stopDeadline;
        if (!released && !expired) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_MSEC),
                           dispatch_get_main_queue(), ^{
                               [self pollStop];
                           });
            return;
        }
        NSError *error =
            released
                ? nil
                : [NSError
                      errorWithDomain:@"URN"
                                 code:1
                             userInfo:@{
                                 NSLocalizedDescriptionKey : [NSString
                                     stringWithFormat:@"旧 RN 运行时未完成释放（Host=%d Factory=%d "
                                                      @"JSI=%d Modules=%lu）",
                                                      _retiredHost != nil, _retiredFactory != nil,
                                                      _runtimeDestroyed, (unsigned long)modules],
                                 @"code" : @"RUNTIME_RELEASE_TIMEOUT"
                             }];
        NSArray *callbacks = [_stopCallbacks copy];
        [_stopCallbacks removeAllObjects];
        for (void (^callback)(NSError *) in callbacks)
            callback(error);
    }
}
@end
