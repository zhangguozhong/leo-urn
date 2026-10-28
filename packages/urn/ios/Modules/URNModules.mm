#import "URNModules.h"

@implementation URNChannelModule {
    __weak id<URNModuleSink> _sink;
    NSString *_generation;
    BOOL _invalidated;
}
RCT_EXPORT_MODULE(URNChannel)
+ (BOOL)requiresMainQueueSetup {
    return NO;
}
- (instancetype)initWithSink:(id<URNModuleSink>)sink generation:(NSString *)generation {
    if ((self = [super init])) {
        _sink = sink;
        _generation = [generation copy];
        [sink moduleCreated];
    }
    return self;
}
- (void)acknowledge:(NSString *)generation
            channel:(NSString *)channel
         deliveryId:(NSString *)deliveryId {
    id<URNModuleSink> sink;
    @synchronized(self) {
        if (_invalidated || ![_generation isEqual:generation])
            return;
        sink = _sink;
    }
    [sink acknowledgeGeneration:generation channel:channel deliveryId:deliveryId];
}
- (void)send:(NSString *)generation channelId:(NSString *)channel message:(NSString *)message {
    id<URNModuleSink> sink;
    @synchronized(self) {
        if (_invalidated || ![_generation isEqual:generation])
            return;
        sink = _sink;
    }
    [sink receiveGeneration:generation channel:channel message:message];
}
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
    return std::make_shared<facebook::react::NativeURNChannelSpecJSI>(params);
}
- (void)invalidate {
    id<URNModuleSink> sink;
    @synchronized(self) {
        if (_invalidated)
            return;
        _invalidated = YES;
        sink = _sink;
    }
    [sink moduleInvalidated:@"URNChannel" generation:_generation];
}
- (void)dealloc {
    [_sink moduleDestroyed];
}
@end

@implementation URNLifecycleModule {
    __weak id<URNModuleSink> _sink;
    NSString *_generation;
    BOOL _invalidated;
}
RCT_EXPORT_MODULE(URNLifecycle)
+ (BOOL)requiresMainQueueSetup {
    return NO;
}
- (instancetype)initWithSink:(id<URNModuleSink>)sink generation:(NSString *)generation {
    if ((self = [super init])) {
        _sink = sink;
        _generation = [generation copy];
        [sink moduleCreated];
    }
    return self;
}
- (void)command:(NSString *)generation
        channel:(NSString *)channel
        command:(NSString *)command
             id:(NSString *)requestId
        payload:(NSString *)payload {
    id<URNModuleSink> sink;
    @synchronized(self) {
        if (_invalidated || ![_generation isEqual:generation])
            return;
        sink = _sink;
    }
    [sink command:command
        generation:generation
           channel:channel
         requestId:requestId
           payload:payload];
}
- (void)boot:(NSString *)generation {
    id<URNModuleSink> sink;
    @synchronized(self) {
        if (_invalidated || ![_generation isEqual:generation])
            return;
        sink = _sink;
    }
    [sink bootGeneration:generation];
}
- (void)signal:(NSString *)event
    generation:(NSString *)generation
       channel:(NSString *)channel
          code:(NSString *)code
       message:(NSString *)message {
    id<URNModuleSink> sink;
    @synchronized(self) {
        if (_invalidated || ![_generation isEqual:generation])
            return;
        sink = _sink;
    }
    [sink lifecycle:event generation:generation channel:channel code:code message:message];
}
- (void)mounted:(NSString *)generation channel:(NSString *)channel {
    [self signal:@"mounted" generation:generation channel:channel code:@"" message:@""];
}
- (void)bridgeReady:(NSString *)generation channel:(NSString *)channel {
    [self signal:@"bridgeReady" generation:generation channel:channel code:@"" message:@""];
}
- (void)ready:(NSString *)generation channel:(NSString *)channel {
    [self signal:@"ready" generation:generation channel:channel code:@"" message:@""];
}
- (void)startupFailed:(NSString *)generation
              channel:(NSString *)channel
                 code:(NSString *)code
              message:(NSString *)message {
    [self signal:@"startupFailed" generation:generation channel:channel code:code message:message];
}
- (void)disposed:(NSString *)generation channel:(NSString *)channel {
    [self signal:@"disposed" generation:generation channel:channel code:@"" message:@""];
}
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
    return std::make_shared<facebook::react::NativeURNLifecycleSpecJSI>(params);
}
- (void)invalidate {
    id<URNModuleSink> sink;
    @synchronized(self) {
        if (_invalidated)
            return;
        _invalidated = YES;
        sink = _sink;
    }
    [sink moduleInvalidated:@"URNLifecycle" generation:_generation];
}
- (void)dealloc {
    [_sink moduleDestroyed];
}
@end
