#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN
/// 调用者先验证活动 channel。打开最多32条；每个活动 channel 独立保留关闭和16条撤销名额。
@interface URNPageCommandQueue : NSObject
- (void)submitChannel:(NSString *)channel
              command:(NSString *)command
            requestId:(NSString *)requestId
                 work:(dispatch_block_t)work
             rejected:(dispatch_block_t)rejected;
@end
NS_ASSUME_NONNULL_END
