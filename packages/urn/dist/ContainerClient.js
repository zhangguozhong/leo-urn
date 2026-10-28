import { ClientCore } from 'aeris-client-core/ClientCore';
import { RNAdapter } from 'aeris-react-native/RNAdapter';
import { PageExperience } from './PageExperience.js';
import { URNError } from './URNError.js';
/** Core 因协议错误自行关闭时，将 Adapter 最终关闭同步到容器所有权。 */
class PageAdapter extends RNAdapter {
    didClose;
    constructor(port, didClose) {
        super(port);
        this.didClose = didClose;
    }
    close() {
        const closing = super.close();
        // 不等待页面 close：它需要等待 Core 当前的 closeTask，互相等待会死锁。
        this.didClose();
        return closing;
    }
}
/** 页面独占 Core/Adapter；只向业务暴露受关闭窗口保护的 call/subscribe。 */
export class ContainerClient {
    pageId;
    featureId;
    port;
    core;
    phase = 'active';
    closing;
    environment;
    experience;
    constructor(pageId, featureId, port, onError, command = () => {
        throw new URNError('NAVIGATION_UNAVAILABLE', '原生导航未接入');
    }) {
        this.pageId = pageId;
        this.featureId = featureId;
        this.port = port;
        this.core = new ClientCore(new PageAdapter(port, () => {
            void this.close();
        }), onError);
        this.experience = new PageExperience(command, onError);
        this.environment = Object.freeze({
            lifecycle: this.experience.lifecycle,
            navigation: this.experience.navigation,
            pageId,
            featureId,
            bridge: Object.freeze({
                call: (method, params, callback, options) => {
                    this.assertActive();
                    return this.core.call(method, params, callback, options);
                },
                subscribe: async (...args) => {
                    this.assertActive();
                    return this.core.subscribe(...args);
                },
            }),
        });
    }
    get active() {
        return this.phase === 'active';
    }
    assertActive() {
        if (!this.active)
            throw new URNError('DISCONNECTED', '页面已进入关闭窗口');
    }
    ready() {
        if (!this.active)
            return Promise.reject(new URNError('DISCONNECTED', '页面已关闭'));
        return this.core.ready();
    }
    close() {
        if (this.closing)
            return this.closing;
        this.phase = 'closing';
        this.experience.close();
        // 先存储共享任务，避免 Core 的同步关闭回调重入时创建第二条销毁链。
        this.closing = Promise.resolve().then(async () => {
            try {
                await this.core.dispose();
            }
            finally {
                this.port.close();
                this.phase = 'closed';
            }
        });
        return this.closing;
    }
}
