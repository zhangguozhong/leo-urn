import { assertJSON, utf8Size } from 'aeris-client-core/protocol';
import { URNError } from './URNError.js';

export interface PageLifecycleSnapshot {
  readonly visible: boolean;
  readonly foreground: boolean;
  readonly closed: boolean;
}
export interface PageLifecycle {
  readonly snapshot: PageLifecycleSnapshot;
  /** 立即回放当前快照；返回取消监听函数。隐藏和后台都不关闭页面连接。 */
  subscribe(listener: (state: PageLifecycleSnapshot) => void): () => void;
}
export type PageResult =
  | { readonly status: 'completed'; readonly data?: Record<string, unknown> }
  | { readonly status: 'cancelled' };
export interface PageNavigation {
  open(
    featureId: string,
    params?: Record<string, unknown>,
    options?: { readonly presentation?: 'push' | 'present' },
  ): Promise<PageResult>;
  /** 完成导航移除后才向调用页返回；原生拒绝关闭通过 onError 报告。 */
  close(result?: Record<string, unknown>): void;
}

interface Pending {
  resolve: (result: PageResult) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

function jsonObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('需要JSON对象');
  assertJSON(value);
}

/** 每页独占：导航请求、结果和生命周期都不会共享到其他 Client。 */
export class PageExperience {
  private state: PageLifecycleSnapshot = Object.freeze({
    visible: false,
    foreground: true,
    closed: false,
  });
  private seq = 0;
  private nextId = 0;
  private readonly listeners = new Set<(state: PageLifecycleSnapshot) => void>();
  private readonly pending = new Map<string, Pending>();
  readonly lifecycle: PageLifecycle;
  readonly navigation: PageNavigation;

  constructor(
    private readonly command: (command: string, id: string, payload: string) => void,
    private readonly onError: (error: unknown) => void,
    private readonly launchTimeout = 15000,
  ) {
    const owner = this;
    this.lifecycle = Object.freeze({
      get snapshot() {
        return owner.state;
      },
      subscribe: (listener: (state: PageLifecycleSnapshot) => void) => {
        if (!this.state.closed) this.listeners.add(listener);
        this.notify(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
    });
    this.navigation = Object.freeze({
      open: async (
        featureId: string,
        params: Record<string, unknown> = {},
        options?: { readonly presentation?: 'push' | 'present' },
      ) => {
        this.assertActive();
        if (this.pending.size >= 16)
          throw new URNError('NAVIGATION_LIMIT', '等待返回的页面数量达到上限');
        const payload = this.encode({
          featureId,
          params,
          presentation: options?.presentation ?? 'push',
        });
        if (
          !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(featureId) ||
          featureId.length > 80 ||
          !['push', 'present'].includes(options?.presentation ?? 'push')
        )
          throw new URNError('INVALID_NAVIGATION', '业务入口或呈现方式不合法');
        try {
          jsonObject(params);
        } catch {
          throw new URNError('INVALID_NAVIGATION', '导航参数必须是JSON对象');
        }
        const id = String(++this.nextId);
        return new Promise<PageResult>((resolve, reject) => {
          const entry: Pending = { resolve, reject };
          entry.timer = setTimeout(() => {
            this.reject(id, new URNError('NAVIGATION_TIMEOUT', '原生未确认打开页面'));
            try {
              this.command('cancelOpen', id, '{}');
            } catch (error) {
              this.report(error);
            }
          }, this.launchTimeout);
          this.pending.set(id, entry);
          try {
            this.command('open', id, payload);
          } catch (error) {
            this.reject(id, error);
          }
        });
      },
      close: (result?: Record<string, unknown>) => {
        this.assertActive();
        if (result !== undefined) {
          try {
            jsonObject(result);
          } catch {
            throw new URNError('INVALID_NAVIGATION', '返回值须为JSON对象');
          }
        }
        this.command('close', '', this.encode(result === undefined ? {} : { data: result }));
      },
    });
  }

  private assertActive(): void {
    if (this.state.closed) throw new URNError('DISCONNECTED', '页面已关闭');
  }
  private encode(value: unknown): string {
    try {
      assertJSON(value);
      const text = JSON.stringify(value);
      if (utf8Size(text) > 16384) throw Error('导航参数过大');
      return text;
    } catch {
      throw new URNError('INVALID_NAVIGATION', '导航参数须为16KB以内的JSON');
    }
  }
  private notify(listener: (state: PageLifecycleSnapshot) => void): void {
    try {
      listener(this.state);
    } catch (error) {
      this.report(error);
    }
  }
  private report(error: unknown): void {
    try {
      this.onError(error);
    } catch {
      /* 诊断异常不能中断其他页面。 */
    }
  }
  private reject(id: string, error: unknown): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.reject(error);
  }

  receive(value: unknown): void {
    if (this.state.closed) return;
    try {
      jsonObject(value);
      if (value.type === 'lifecycle') {
        if (
          !Number.isSafeInteger(value.seq) ||
          typeof value.seq !== 'number' ||
          value.seq <= 0 ||
          typeof value.visible !== 'boolean' ||
          typeof value.foreground !== 'boolean'
        )
          throw Error('生命周期快照不合法');
        if (value.seq <= this.seq) return;
        this.seq = value.seq;
        this.state = Object.freeze({
          visible: value.visible,
          foreground: value.foreground,
          closed: false,
        });
        for (const listener of [...this.listeners]) this.notify(listener);
        return;
      }
      if (
        typeof value.id !== 'string' ||
        !['opened', 'result', 'error'].includes(String(value.type))
      )
        throw Error('导航响应不合法');
      if (value.type === 'error' && value.id === '') {
        if (typeof value.code !== 'string') throw Error('缺少错误码');
        this.report(new URNError(value.code, '原生拒绝关闭页面'));
        return;
      }
      const entry = this.pending.get(value.id);
      if (!entry) return;
      if (value.type === 'opened') {
        if (typeof value.pageId !== 'string' || !value.pageId) throw Error('缺少目标页面');
        clearTimeout(entry.timer);
      } else if (value.type === 'error') {
        if (typeof value.code !== 'string') throw Error('缺少错误码');
        this.reject(value.id, new URNError(value.code, '原生导航失败'));
      } else {
        jsonObject(value.result);
        const result = value.result;
        if (result.status !== 'completed' && result.status !== 'cancelled')
          throw Error('返回状态不合法');
        if (result.data !== undefined) jsonObject(result.data);
        clearTimeout(entry.timer);
        this.pending.delete(value.id);
        entry.resolve(
          result.status === 'completed'
            ? { status: 'completed', ...(result.data === undefined ? {} : { data: result.data }) }
            : { status: 'cancelled' },
        );
      }
    } catch (error) {
      this.report(error);
    }
  }

  close(): void {
    if (this.state.closed) return;
    this.state = Object.freeze({ ...this.state, visible: false, closed: true });
    for (const listener of [...this.listeners]) this.notify(listener);
    this.listeners.clear();
    for (const id of this.pending.keys())
      this.reject(id, new URNError('DISCONNECTED', '调用页面已关闭'));
  }
}
