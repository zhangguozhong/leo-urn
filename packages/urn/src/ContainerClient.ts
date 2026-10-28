import { ClientCore } from 'aeris-client-core/ClientCore';
import { RNAdapter } from 'aeris-react-native/RNAdapter';
import type { CallCallbacks, CallOptions, Completion } from 'aeris-client-core/protocol';
import type { FeatureEnvironment } from './FeatureEnvironment.js';
import { ChannelPort } from './ChannelPort.js';
import { PageExperience } from './PageExperience.js';
import { URNError } from './URNError.js';

/** Core 因协议错误自行关闭时，将 Adapter 最终关闭同步到容器所有权。 */
class PageAdapter extends RNAdapter {
  constructor(
    port: ChannelPort,
    private readonly didClose: () => void,
  ) {
    super(port);
  }

  override close(): Promise<void> {
    const closing = super.close();
    // 不等待页面 close：它需要等待 Core 当前的 closeTask，互相等待会死锁。
    this.didClose();
    return closing;
  }
}

/** 页面独占 Core/Adapter；只向业务暴露受关闭窗口保护的 call/subscribe。 */
export class ContainerClient {
  private readonly core: ClientCore;
  private phase: 'active' | 'closing' | 'closed' = 'active';
  private closing?: Promise<void>;
  readonly environment: FeatureEnvironment;
  readonly experience: PageExperience;

  constructor(
    readonly pageId: string,
    readonly featureId: string,
    readonly port: ChannelPort,
    onError: (error: unknown) => void,
    command: (command: string, id: string, payload: string) => void = () => {
      throw new URNError('NAVIGATION_UNAVAILABLE', '原生导航未接入');
    },
  ) {
    this.core = new ClientCore(
      new PageAdapter(port, () => {
        void this.close();
      }),
      onError,
    );
    this.experience = new PageExperience(command, onError);
    this.environment = Object.freeze({
      lifecycle: this.experience.lifecycle,
      navigation: this.experience.navigation,
      pageId,
      featureId,
      bridge: Object.freeze({
        call: <T>(
          method: string,
          params: Record<string, unknown>,
          callback: Completion<T> | CallCallbacks<T>,
          options?: CallOptions,
        ) => {
          this.assertActive();
          return this.core.call(method, params, callback, options);
        },
        subscribe: async (...args: Parameters<ClientCore['subscribe']>) => {
          this.assertActive();
          return this.core.subscribe(...args);
        },
      }),
    });
  }

  get active(): boolean {
    return this.phase === 'active';
  }

  private assertActive(): void {
    if (!this.active) throw new URNError('DISCONNECTED', '页面已进入关闭窗口');
  }

  ready(): Promise<void> {
    if (!this.active) return Promise.reject(new URNError('DISCONNECTED', '页面已关闭'));
    return this.core.ready();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.phase = 'closing';
    this.experience.close();
    // 先存储共享任务，避免 Core 的同步关闭回调重入时创建第二条销毁链。
    this.closing = Promise.resolve().then(async () => {
      try {
        await this.core.dispose();
      } finally {
        this.port.close();
        this.phase = 'closed';
      }
    });
    return this.closing;
  }
}
