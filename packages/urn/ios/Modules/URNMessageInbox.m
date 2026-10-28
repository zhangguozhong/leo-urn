#import "URNMessageInbox.h"
#import "URNChannelBudgetDefaults.h"

// 文件内部的 C 辅助函数，不是 Objective-C 实例方法。
static BOOL URNValidAddress(NSString *value) {
    if (![value isKindOfClass:NSString.class] || !value.length ||
        [value lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 80)
        return NO;
    NSCharacterSet *allowed =
        [NSCharacterSet characterSetWithCharactersInString:
                            @"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"];
    return [value rangeOfCharacterFromSet:allowed.invertedSet].location == NSNotFound;
}

@interface URNInboxPage : NSObject
@property (nonatomic, strong) NSMutableArray<NSString *> *messages;
@property (nonatomic) NSUInteger bytes;
@property (nonatomic) BOOL blocked;
@end
@implementation URNInboxPage
- (instancetype)init {
    if ((self = [super init]))
        _messages = [NSMutableArray new];
    return self;
}
@end

@interface URNMessageInbox ()
- (void)drain;
@end

@implementation URNMessageInbox {
    NSString *_generation;
    NSMutableDictionary<NSString *, URNInboxPage *> *_pages;
    NSMutableArray<NSString *> *_order;
    NSMutableSet<NSString *> *_retired;
    NSUInteger _maxMessages, _maxBytes, _pageMessages, _pageBytes;
    NSUInteger _maxFrameBytes, _maxChannels, _maxRetired, _batchSize;
    NSUInteger _messages, _bytes, _cursor;
    BOOL _scheduled, _invalidated;
}

- (instancetype)initWithMaxMessages:(NSUInteger)messages
                           maxBytes:(NSUInteger)bytes
                       pageMessages:(NSUInteger)pageMessages
                          pageBytes:(NSUInteger)pageBytes {
    NSMutableDictionary *budget = [URNDefaultChannelBudget() mutableCopy];
    budget[@"nativeMessages"] = @(MAX(1, messages));
    budget[@"nativeBytes"] = @(MAX(1, bytes));
    budget[@"nativePageMessages"] = @(MIN(MAX(1, messages), MAX(1, pageMessages)));
    budget[@"nativePageBytes"] = @(MIN(MAX(1, bytes), MAX(1, pageBytes)));
    // 旧入口的总量可小于默认单帧/批次；收窄到其本来就能容纳的有效值。
    budget[@"maxFrameBytes"] = @(MIN([budget[@"maxFrameBytes"] unsignedIntegerValue],
                                     [budget[@"nativePageBytes"] unsignedIntegerValue]));
    budget[@"nativeBatchSize"] = @(MIN([budget[@"nativeBatchSize"] unsignedIntegerValue],
                                       [budget[@"nativeMessages"] unsignedIntegerValue]));
    return [self initWithChannelBudget:budget];
}

- (instancetype)initWithChannelBudget:(NSDictionary<NSString *, NSNumber *> *)budget {
    if (![budget isKindOfClass:NSDictionary.class])
        return nil;
    for (NSString *key in URNDefaultChannelBudget()) {
        NSNumber *value = budget[key];
        if (![value isKindOfClass:NSNumber.class] || !isfinite(value.doubleValue) ||
            CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID() ||
            value.doubleValue < 1 || floor(value.doubleValue) != value.doubleValue ||
            value.doubleValue > 256 * 1024 * 1024)
            return nil;
    }
    if ([budget[@"maxChannels"] unsignedIntegerValue] > 64 ||
        [budget[@"maxRetiredChannels"] unsignedIntegerValue] > 65536 ||
        [budget[@"maxFrameBytes"] unsignedIntegerValue] > 16 * 1024 * 1024 ||
        [budget[@"jsPageMessages"] unsignedIntegerValue] > 65536 ||
        [budget[@"nativeMessages"] unsignedIntegerValue] > 65536 ||
        [budget[@"nativePageMessages"] unsignedIntegerValue] > 65536 ||
        [budget[@"jsPageBytes"] unsignedIntegerValue] > 64 * 1024 * 1024 ||
        [budget[@"nativePageBytes"] unsignedIntegerValue] > 64 * 1024 * 1024 ||
        [budget[@"jsPageBytes"] unsignedIntegerValue] <
            [budget[@"maxFrameBytes"] unsignedIntegerValue] ||
        [budget[@"nativePageBytes"] unsignedIntegerValue] <
            [budget[@"maxFrameBytes"] unsignedIntegerValue] ||
        [budget[@"nativeBatchSize"] unsignedIntegerValue] > 512 ||
        [budget[@"nativeBatchSize"] unsignedIntegerValue] >
            [budget[@"nativeMessages"] unsignedIntegerValue] ||
        [budget[@"nativePageMessages"] unsignedIntegerValue] >
            [budget[@"nativeMessages"] unsignedIntegerValue] ||
        [budget[@"nativePageBytes"] unsignedIntegerValue] >
            [budget[@"nativeBytes"] unsignedIntegerValue])
        return nil;
    if ((self = [super init])) {
        _maxMessages = [budget[@"nativeMessages"] unsignedIntegerValue];
        _maxBytes = [budget[@"nativeBytes"] unsignedIntegerValue];
        _pageMessages = [budget[@"nativePageMessages"] unsignedIntegerValue];
        _pageBytes = [budget[@"nativePageBytes"] unsignedIntegerValue];
        _maxFrameBytes = [budget[@"maxFrameBytes"] unsignedIntegerValue];
        _maxChannels = [budget[@"maxChannels"] unsignedIntegerValue];
        _maxRetired = [budget[@"maxRetiredChannels"] unsignedIntegerValue];
        _batchSize = [budget[@"nativeBatchSize"] unsignedIntegerValue];
        _pages = [NSMutableDictionary new];
        _order = [NSMutableArray new];
        _retired = [NSMutableSet new];
    }
    return self;
}

- (void)activateGeneration:(NSString *)generation {
    @synchronized(self) {
        // 每个 Inbox 只属于一个实际 Runtime，不允许原地更换轮次后复用旧队列。
        if (!_invalidated && !_generation && URNValidAddress(generation))
            _generation = [generation copy];
    }
}

- (BOOL)registerChannel:(NSString *)channel {
    if (!URNValidAddress(channel))
        return NO;
    channel = [channel copy];
    @synchronized(self) {
        if (_invalidated || !_generation || !URNValidAddress(channel) || _pages[channel] ||
            [_retired containsObject:channel] || _retired.count >= _maxRetired ||
            _pages.count >= _maxChannels)
            return NO;
        _pages[channel] = [URNInboxPage new];
        [_order addObject:channel];
        return YES;
    }
}

- (void)retireChannel:(NSString *)channel {
    if (!URNValidAddress(channel))
        return;
    channel = [channel copy];
    @synchronized(self) {
        URNInboxPage *page = _pages[channel];
        if (!page)
            return;
        _messages -= page.messages.count;
        _bytes -= page.bytes;
        [_pages removeObjectForKey:channel];
        [_order removeObject:channel];
        [_retired addObject:channel];
        _cursor = _order.count ? _cursor % _order.count : 0;
    }
}

- (BOOL)containsGeneration:(NSString *)generation channel:(NSString *)channel {
    if (!URNValidAddress(generation) || !URNValidAddress(channel))
        return NO;
    @synchronized(self) {
        return !_invalidated && [_generation isEqual:generation] && _pages[channel] != nil;
    }
}

- (BOOL)enqueueGeneration:(NSString *)generation
                  channel:(NSString *)channel
                  message:(NSString *)message {
    if (!URNValidAddress(generation) || !URNValidAddress(channel) ||
        ![message isKindOfClass:NSString.class])
        return NO;
    generation = [generation copy];
    channel = [channel copy];
    message = [message copy];
    NSData *encoded = message.length <= _maxFrameBytes
                          ? [message dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO]
                          : nil;
    BOOL validEncoding = encoded != nil;
    BOOL schedule = NO, fault = NO;
    NSUInteger bytes = encoded.length;
    @synchronized(self) {
        URNInboxPage *page = _pages[channel];
        if (_invalidated || ![_generation isEqual:generation] || !page || page.blocked)
            return NO;
        if (!validEncoding || bytes > _maxFrameBytes || page.messages.count >= _pageMessages ||
            bytes > _pageBytes - page.bytes || _messages >= _maxMessages ||
            bytes > _maxBytes - _bytes) {
            // 故障页封闭业务队列；生命周期模块仍走独立控制入口完成取消和关闭。
            page.blocked = YES;
            _messages -= page.messages.count;
            _bytes -= page.bytes;
            [page.messages removeAllObjects];
            page.bytes = 0;
            fault = YES;
        } else {
            [page.messages addObject:[message copy]];
            page.bytes += bytes;
            _messages++;
            _bytes += bytes;
            if (!_scheduled) {
                _scheduled = YES;
                schedule = YES;
            }
        }
    }
    __weak URNMessageInbox *weakSelf = self;
    if (fault) {
        dispatch_async(dispatch_get_main_queue(), ^{
            URNMessageInbox *self = weakSelf;
            void (^callback)(NSString *, NSString *, NSString *) = self.fault;
            if ([self containsGeneration:generation channel:channel] && callback)
                callback(generation, channel, @"原生入站消息或字节预算超额");
        });
    }
    if (schedule)
        dispatch_async(dispatch_get_main_queue(), ^{
            [weakSelf drain];
        });
    return !fault;
}

- (void)drain {
    // 每轮按有效批次预算投递，让 UIKit 转场与独立生命周期控制有机会执行。
    for (NSUInteger delivered = 0; delivered < _batchSize; delivered++) {
        NSString *message, *channel, *generation;
        @synchronized(self) {
            if (_invalidated || _messages == 0) {
                _scheduled = NO;
                return;
            }
            for (NSUInteger searched = 0; searched < _order.count; searched++) {
                channel = _order[_cursor];
                _cursor = (_cursor + 1) % _order.count;
                URNInboxPage *page = _pages[channel];
                if (page.messages.count == 0)
                    continue;
                message = page.messages.firstObject;
                [page.messages removeObjectAtIndex:0];
                NSUInteger bytes = [message lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
                page.bytes -= bytes;
                _messages--;
                _bytes -= bytes;
                generation = _generation;
                break;
            }
        }
        void (^callback)(NSString *, NSString *, NSString *) = self.delivery;
        if (message && callback)
            callback(generation, channel, message);
    }
    __weak URNMessageInbox *weakSelf = self;
    dispatch_async(dispatch_get_main_queue(), ^{
        [weakSelf drain];
    });
}

- (NSDictionary<NSString *, NSNumber *> *)snapshot {
    @synchronized(self) {
        return @{@"messages" : @(_messages), @"bytes" : @(_bytes), @"channels" : @(_pages.count)};
    }
}

- (void)invalidate {
    @synchronized(self) {
        _invalidated = YES;
        [_pages removeAllObjects];
        [_order removeAllObjects];
        [_retired removeAllObjects];
        _messages = 0;
        _bytes = 0;
    }
    self.delivery = nil;
    self.fault = nil;
}
@end
