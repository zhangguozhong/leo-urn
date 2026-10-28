#import <Foundation/Foundation.h>
NS_ASSUME_NONNULL_BEGIN
/// 确认前持续占用预算，避免消息移入 RN 队列后失去背压；不解析 Aeris 业务协议。
@interface URNMessageOutbox : NSObject
- (instancetype)initWithChannelBudget:(NSDictionary<NSString *, NSNumber *> *)budget;
@property (nonatomic, copy, nullable) void (^delivery)
    (NSString *generation, NSString *channel, NSString *deliveryId, NSString *kind,
     NSString *message);
@property (nonatomic, copy, nullable) void (^fault)(NSString *channel);
- (void)activateGeneration:(NSString *)generation;
- (BOOL)registerChannel:(NSString *)channel;
- (void)enqueueChannel:(NSString *)channel
                  kind:(NSString *)kind
               message:(NSString *)message
               control:(BOOL)control;
/// 确认不依赖活动通道表：退役页面的迟到帧也必须归还在途信用。
- (void)acknowledgeGeneration:(NSString *)generation
                      channel:(NSString *)channel
                   deliveryId:(NSString *)deliveryId;
- (void)retireChannel:(NSString *)channel;
- (NSDictionary<NSString *, NSNumber *> *)snapshot;
- (void)invalidate;
@end
NS_ASSUME_NONNULL_END
