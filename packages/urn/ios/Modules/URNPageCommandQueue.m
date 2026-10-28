#import "URNPageCommandQueue.h"

@implementation URNPageCommandQueue {
    NSUInteger _opens;
    NSMutableDictionary<NSString *, NSMutableSet<NSString *> *> *_terminations;
    NSMutableSet<NSString *> *_rejections;
}
- (instancetype)init {
    if ((self = [super init])) {
        _terminations = [NSMutableDictionary new];
        _rejections = [NSMutableSet new];
    }
    return self;
}
- (void)submitChannel:(NSString *)channel
              command:(NSString *)command
            requestId:(NSString *)requestId
                 work:(dispatch_block_t)work
             rejected:(dispatch_block_t)rejected {
    channel = [channel copy];
    BOOL terminal = [command isEqual:@"close"] || [command isEqual:@"cancelOpen"];
    NSString *key =
        [command isEqual:@"close"] ? @"close" : [@"cancel:" stringByAppendingString:requestId];
    @synchronized(self) {
        NSMutableSet *keys = _terminations[channel];
        if (terminal && [keys containsObject:key])
            return;
        BOOL full = terminal ? (![command isEqual:@"close"] &&
                                (keys.count - ([keys containsObject:@"close"] ? 1 : 0)) >= 16)
                             : _opens >= 32;
        if (full) {
            // 活动 channel 数量由 Host 限制；每页只允许一个待执行的故障通知。
            if ([_rejections containsObject:channel])
                return;
            [_rejections addObject:channel];
            dispatch_async(dispatch_get_main_queue(), ^{
                @synchronized(self) {
                    [self->_rejections removeObject:channel];
                }
                rejected();
            });
            return;
        }
        if (terminal) {
            if (!keys) {
                keys = [NSMutableSet new];
                _terminations[channel] = keys;
            }
            [keys addObject:key];
        } else {
            _opens++;
        }
    }
    dispatch_async(dispatch_get_main_queue(), ^{
        @synchronized(self) {
            if (terminal) {
                NSMutableSet *keys = self->_terminations[channel];
                [keys removeObject:key];
                if (keys.count == 0)
                    [self->_terminations removeObjectForKey:channel];
            } else {
                self->_opens--;
            }
        }
        work();
    });
}
@end
