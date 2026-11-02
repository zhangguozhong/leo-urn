export interface URNDiagnostic {
  readonly timestampMs: number;
  readonly stage: string;
  readonly runtimeGeneration?: string;
  readonly pageId?: string;
  readonly channelId?: string;
  readonly featureId?: string;
  readonly durationMs?: number;
  readonly code?: string;
  readonly queuedMessages?: number;
  readonly queuedBytes?: number;
}

/** 观察器在当前状态转换退出后运行；不把观察器异常再次送回诊断系统。 */
export function publishDiagnostic(
  observer: ((event: URNDiagnostic) => void) | undefined,
  data: Omit<URNDiagnostic, 'timestampMs'>,
): void {
  if (!observer) return;
  const event = Object.freeze({ ...data, timestampMs: Date.now() });
  queueMicrotask(() => {
    try {
      observer(event);
    } catch {
      /* 诊断系统不拥有业务生命周期。 */
    }
  });
}

/** 只复制诊断白名单，业务参数、错误消息和凭据不进入报告。 */
export class DiagnosticStore {
  private events: readonly URNDiagnostic[] = Object.freeze([]);
  private listeners = new Set<() => void>();
  constructor(private readonly capacity = 128) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1024)
      throw Error('诊断预算须在1至1024');
  }
  get snapshot(): readonly URNDiagnostic[] {
    return this.events;
  }
  readonly getSnapshot = (): readonly URNDiagnostic[] => this.events;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  record(event: URNDiagnostic): void {
    const safe: Record<string, unknown> = {};
    for (const key of [
      'timestampMs',
      'stage',
      'runtimeGeneration',
      'pageId',
      'channelId',
      'durationMs',
      'code',
      'queuedMessages',
      'queuedBytes',
    ] as const) {
      const value = event[key];
      if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
      if (typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(value)) safe[key] = value;
    }
    this.events = Object.freeze(
      [
        ...this.events.slice(-(this.capacity - 1)),
        Object.freeze(safe) as unknown as URNDiagnostic,
      ].slice(-this.capacity),
    );
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        /* 观察器不拥有容器。 */
      }
    }
  }
  exportReport(): string {
    return JSON.stringify({ version: 1, events: this.events });
  }
}
