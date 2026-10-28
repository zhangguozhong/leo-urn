#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN
/// 模块可从自己的队列调用；实现负责有界入队，业务和 UI 只在主队列执行。
@protocol URNModuleSink <NSObject>
- (void)command:(NSString *)command
     generation:(NSString *)generation
        channel:(NSString *)channel
      requestId:(NSString *)requestId
        payload:(NSString *)payload;
- (void)acknowledgeGeneration:(NSString *)generation
                      channel:(NSString *)channel
                   deliveryId:(NSString *)deliveryId;
- (void)bootGeneration:(NSString *)generation;
- (void)receiveGeneration:(NSString *)generation
                  channel:(NSString *)channel
                  message:(NSString *)message;
- (void)lifecycle:(NSString *)event
       generation:(NSString *)generation
          channel:(NSString *)channel
             code:(NSString *)code
          message:(NSString *)message;
- (void)moduleInvalidated:(NSString *)module generation:(NSString *)generation;
- (void)moduleCreated;
- (void)moduleDestroyed;
@end
NS_ASSUME_NONNULL_END
