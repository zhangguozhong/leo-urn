#import "URNMessageOutbox.h"

@interface URNOutboundFrame : NSObject
@property (nonatomic, copy) NSString *channel, *identity, *kind, *text;
@property (nonatomic) NSUInteger bytes;
@property (nonatomic) BOOL control;
@end
@implementation URNOutboundFrame
@end

@interface URNOutboundPage : NSObject
@property (nonatomic) NSMutableArray<URNOutboundFrame *> *waiting;
@property (nonatomic) NSUInteger messages, bytes, inFlight;
@property (nonatomic) BOOL failed, controlPending, retired;
@end
@implementation URNOutboundPage
- (instancetype)init {
    if ((self = [super init]))
        _waiting = [NSMutableArray new];
    return self;
}
@end

@implementation URNMessageOutbox {
    NSString *_generation;
    NSMutableDictionary<NSString *, URNOutboundPage *> *_pages;
    NSMutableDictionary<NSString *, URNOutboundFrame *> *_inFlight;
    NSMutableArray<NSString *> *_order;
    NSUInteger _messages, _bytes, _controls, _flying, _flyingControls, _cursor;
    NSUInteger _maxMessages, _maxBytes, _pageMessages, _pageBytes, _maxFrame, _maxChannels;
    NSUInteger _window, _globalWindow, _batch;
    BOOL _scheduled, _invalidated;
}
- (instancetype)initWithChannelBudget:(NSDictionary<NSString *, NSNumber *> *)budget {
    if ((self = [super init])) {
        _pages = [NSMutableDictionary new];
        _inFlight = [NSMutableDictionary new];
        _order = [NSMutableArray new];
        _maxMessages = [budget[@"nativeMessages"] unsignedIntegerValue];
        _maxBytes = [budget[@"nativeBytes"] unsignedIntegerValue];
        _pageMessages = [budget[@"nativePageMessages"] unsignedIntegerValue];
        _pageBytes = [budget[@"nativePageBytes"] unsignedIntegerValue];
        _maxFrame = [budget[@"maxFrameBytes"] unsignedIntegerValue];
        _maxChannels = [budget[@"maxChannels"] unsignedIntegerValue];
        _globalWindow = [budget[@"nativeOutboundGlobalWindow"] unsignedIntegerValue];
        _window = MIN(MIN(_pageMessages, [budget[@"nativeOutboundWindow"] unsignedIntegerValue]),
                      _globalWindow / MAX(1, _maxChannels));
        _batch = [budget[@"nativeBatchSize"] unsignedIntegerValue];
        if (!_maxChannels || !_window || !_batch || !_maxMessages || !_maxBytes || !_pageMessages ||
            !_pageBytes || !_maxFrame)
            return nil;
    }
    return self;
}
- (void)activateGeneration:(NSString *)generation {
    @synchronized(self) {
        if (!_generation && !_invalidated)
            _generation = [generation copy];
    }
}
- (BOOL)registerChannel:(NSString *)channel {
    @synchronized(self) {
        if (_invalidated || !_generation || _pages[channel] || _pages.count >= _maxChannels)
            return NO;
        _pages[channel] = [URNOutboundPage new];
        [_order addObject:channel];
        return YES;
    }
}
- (void)schedule {
    if (_scheduled || _invalidated)
        return;
    _scheduled = YES;
    __weak URNMessageOutbox *weakSelf = self;
    dispatch_async(dispatch_get_main_queue(), ^{
        [weakSelf drain];
    });
}
- (void)releaseFrame:(URNOutboundFrame *)frame page:(URNOutboundPage *)page {
    if (frame.control) {
        _controls--;
        page.controlPending = NO;
    } else {
        _messages--;
        _bytes -= frame.bytes;
        page.messages--;
        page.bytes -= frame.bytes;
    }
}
- (void)enqueueChannel:(NSString *)channel
                  kind:(NSString *)kind
               message:(NSString *)message
               control:(BOOL)control {
    void (^fault)(NSString *);
    @synchronized(self) {
        URNOutboundPage *page = _pages[channel];
        if (_invalidated || !page || (page.failed && !control))
            return;
        NSUInteger bytes = [message lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
        if (control) {
            // 每个页面最多一个关闭槽；退役后未确认的控制帧仍计入全局上限。
            if (page.controlPending || bytes > 1024)
                return;
        } else if (bytes > _maxFrame || page.messages >= _pageMessages ||
                   page.bytes + bytes > _pageBytes || _messages >= _maxMessages ||
                   _bytes + bytes > _maxBytes) {
            page.failed = YES;
            for (URNOutboundFrame *frame in [page.waiting copy]) {
                if (frame.control)
                    continue;
                [self releaseFrame:frame page:page];
                [page.waiting removeObject:frame];
            }
            fault = self.fault;
        } else {
            // 等待与在途合并计量；只有消费确认、丢弃等待帧或 Runtime 销毁才能释放。
        }
        if (!page.failed || control) {
            URNOutboundFrame *frame = [URNOutboundFrame new];
            frame.channel = channel;
            frame.identity = NSUUID.UUID.UUIDString;
            frame.kind = kind;
            frame.text = message;
            frame.bytes = bytes;
            frame.control = control;
            [page.waiting addObject:frame];
            if (control) {
                page.controlPending = YES;
                _controls++;
            } else {
                page.messages++;
                page.bytes += bytes;
                _messages++;
                _bytes += bytes;
            }
            [self schedule];
        }
    }
    if (fault)
        fault(channel);
}
- (void)drain {
    @synchronized(self) {
        _scheduled = NO;
    }
    for (NSUInteger sent = 0; sent < _batch; sent++) {
        URNOutboundFrame *next;
        void (^delivery)(NSString *, NSString *, NSString *, NSString *, NSString *);
        NSString *generation;
        @synchronized(self) {
            if (_invalidated || !_order.count)
                return;
            for (NSUInteger i = 0; i < _order.count; i++) {
                _cursor %= _order.count;
                URNOutboundPage *page = _pages[_order[_cursor++]];
                // 控制槽可以绕过本页普通窗口，普通消息和页面事件共同保持原顺序。
                for (URNOutboundFrame *frame in page.waiting)
                    if (frame.control && _flyingControls < _maxChannels) {
                        next = frame;
                        break;
                    }
                if (!next && !page.retired && page.inFlight < _window && _flying < _globalWindow &&
                    !page.waiting.firstObject.control)
                    next = page.waiting.firstObject;
                if (next) {
                    [page.waiting removeObject:next];
                    _inFlight[next.identity] = next;
                    if (!next.control) {
                        page.inFlight++;
                        _flying++;
                    } else {
                        _flyingControls++;
                    }
                    if (page.retired && !page.waiting.count) {
                        [_pages removeObjectForKey:next.channel];
                        [_order removeObject:next.channel];
                    }
                    break;
                }
            }
            if (!next)
                return;
            generation = _generation;
            delivery = self.delivery;
        }
        if (delivery)
            delivery(generation, next.channel, next.identity, next.kind, next.text);
    }
    @synchronized(self) {
        [self scheduleIfDeliverable];
    }
}
- (void)scheduleIfDeliverable {
    for (URNOutboundPage *page in _pages.allValues) {
        for (URNOutboundFrame *frame in page.waiting) {
            if ((frame.control && _flyingControls < _maxChannels) ||
                (!frame.control && !page.retired && page.inFlight < _window &&
                 _flying < _globalWindow)) {
                [self schedule];
                return;
            }
        }
    }
}
- (void)acknowledgeGeneration:(NSString *)generation
                      channel:(NSString *)channel
                   deliveryId:(NSString *)deliveryId {
    @synchronized(self) {
        if (_invalidated || ![_generation isEqual:generation])
            return;
        URNOutboundFrame *frame = _inFlight[deliveryId];
        if (!frame || ![frame.channel isEqual:channel])
            return;
        URNOutboundPage *page = _pages[channel];
        [self releaseFrame:frame page:page];
        if (!frame.control) {
            _flying--;
            page.inFlight--;
        } else {
            _flyingControls--;
        }
        [_inFlight removeObjectForKey:deliveryId];
        [self scheduleIfDeliverable];
    }
}
- (void)retireChannel:(NSString *)channel {
    @synchronized(self) {
        URNOutboundPage *page = _pages[channel];
        for (URNOutboundFrame *frame in [page.waiting copy]) {
            if (frame.control)
                continue;
            [self releaseFrame:frame page:page];
            [page.waiting removeObject:frame];
        }
        page.retired = YES;
        page.failed = YES;
        // 关闭意图不能在控制窗口满时丢弃。等待控制帧的退役页占用页面槽，阻止无界新建。
        if (!page.waiting.count) {
            [_pages removeObjectForKey:channel];
            [_order removeObject:channel];
        }
        [self scheduleIfDeliverable];
        // 在途表不能随页面释放，RN 内部队列尚未消费的内存仍然存在。
    }
}
- (NSDictionary<NSString *, NSNumber *> *)snapshot {
    @synchronized(self) {
        return @{
            @"messages" : @(_messages),
            @"bytes" : @(_bytes),
            @"inFlight" : @(_flying),
            @"controlMessages" : @(_controls)
        };
    }
}
- (void)invalidate {
    @synchronized(self) {
        _invalidated = YES;
        [_pages removeAllObjects];
        [_order removeAllObjects];
        [_inFlight removeAllObjects];
        _messages = _bytes = _controls = _flying = _flyingControls = 0;
        self.delivery = nil;
        self.fault = nil;
    }
}
@end
