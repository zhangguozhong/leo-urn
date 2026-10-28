#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// 已开始投递的强回调快照允许完成；失效会丢弃尚未出队的消息。
/// JS/模块队列只做有界入队，主队列按页面公平投递；不解析或重编码业务 JSON。
@interface URNMessageInbox : NSObject
- (nullable instancetype)initWithChannelBudget:(NSDictionary<NSString *, NSNumber *> *)budget;
- (instancetype)initWithMaxMessages:(NSUInteger)messages
                           maxBytes:(NSUInteger)bytes
                       pageMessages:(NSUInteger)pageMessages
                          pageBytes:(NSUInteger)pageBytes;
@property (atomic, copy, nullable) void (^delivery)(NSString *, NSString *, NSString *);
@property (atomic, copy, nullable) void (^fault)(NSString *, NSString *, NSString *);
- (void)activateGeneration:(NSString *)generation;
- (BOOL)registerChannel:(NSString *)channel;
- (void)retireChannel:(NSString *)channel;
- (BOOL)containsGeneration:(NSString *)generation channel:(NSString *)channel;
- (BOOL)enqueueGeneration:(NSString *)generation
                  channel:(NSString *)channel
                  message:(NSString *)message;
- (NSDictionary<NSString *, NSNumber *> *)snapshot;
- (void)invalidate;
@end

NS_ASSUME_NONNULL_END
