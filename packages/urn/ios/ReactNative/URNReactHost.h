#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/// 仅暴露 Foundation/UIKit 接口，JSI 和 Codegen 类型留在 Objective-C++ 实现内。
NS_SWIFT_UI_ACTOR
@interface URNReactHost : NSObject
- (instancetype)initWithBundleURL:(NSURL *)bundleURL dependencyProvider:(id)dependencyProvider;
- (nullable instancetype)initWithBundleURL:(NSURL *)bundleURL
                        dependencyProvider:(id)dependencyProvider
                             channelBudget:(NSDictionary<NSString *, NSNumber *> *)channelBudget;
@property (nonatomic, copy, readonly) NSDictionary<NSString *, NSNumber *> *channelBudget;
- (NSDictionary<NSString *, NSNumber *> *)messageQueueSnapshot;
@property (atomic, copy, readonly, nullable) NSString *generation;
@property (nonatomic, copy, nullable) void (^onInitialized)(NSString *generation);
@property (nonatomic, copy, nullable) void (^onBooted)(void);
@property (nonatomic, copy, nullable) void (^onMessage)
    (NSString *generation, NSString *channel, NSString *message);
@property (nonatomic, copy, nullable) void (^onLifecycle)
    (NSString *channel, NSString *event, NSString *code, NSString *message);
@property (nonatomic, copy, nullable) void (^onFault)
    (NSString *_Nullable channel, NSString *code, NSString *message);
@property (nonatomic, copy, nullable) void (^onReloadRequested)(void);
@property (nonatomic, copy, nullable) void (^onCommand)
    (NSString *channel, NSString *command, NSString *requestId, NSString *payload);
- (void)emitPageEvent:(NSString *)message channel:(NSString *)channel;
- (void)start;
- (BOOL)registerChannel:(NSString *)channel;
- (void)retireChannel:(NSString *)channel;
- (nullable UIView *)rootForFeature:(NSString *)feature
                             params:(NSDictionary *)params
                             pageId:(NSString *)pageId
                            channel:(NSString *)channel
                           baseline:(NSString *)baseline;
- (void)emitMessage:(NSString *)message channel:(NSString *)channel;
- (void)requestClose:(NSString *)channel reason:(NSString *)reason;
/// 只能在真实 mounted/startupFailed 后调用，避免 Fabric 注册与启动之间的 stop 竞态。
- (void)detachRoot:(UIView *)root;
/// 根卸载完成后释放 Factory，并等待真实 JSI 析构；超时会明确返回错误。
- (void)stopWithCompletion:(void (^)(NSError *_Nullable error))completion;
@end

NS_ASSUME_NONNULL_END
