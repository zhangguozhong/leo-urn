#import "URNModuleSink.h"
#import <URNSpec/URNSpec.h>
#import <React/RCTInvalidating.h>

NS_ASSUME_NONNULL_BEGIN
@interface URNChannelModule : NativeURNChannelSpecBase <NativeURNChannelSpec, RCTInvalidating>
- (instancetype)initWithSink:(id<URNModuleSink>)sink generation:(NSString *)generation;
@end
@interface URNLifecycleModule : NativeURNLifecycleSpecBase <NativeURNLifecycleSpec, RCTInvalidating>
- (instancetype)initWithSink:(id<URNModuleSink>)sink generation:(NSString *)generation;
@end
NS_ASSUME_NONNULL_END
