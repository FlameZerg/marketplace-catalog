// 采集与生产恢复共用单批次预算；为 Pages 安装依赖和发布预留五分钟。
export const CATALOG_RUN_LIMITS = {
  durationMs: 15 * 60_000,
  requests: 6000,
  bytes: 256 * 1024 * 1024,
  requestTimeoutMs: 30_000,
  ioConcurrency: 4,
} as const;

export interface CatalogRunContext {
  readonly outputDirectory?: string;
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly budget: Readonly<{ requests: number; bytes: number; exceeded: boolean }>;
  check(): void;
  checkCapacity(requests: number, bytes: number): void;
  consumeRequest(): void;
  consumeBytes(bytes: number): void;
  failBudget(): never;
  requestSignal(): AbortSignal;
  measure<T>(stage: string, action: () => Promise<T>): Promise<T>;
}

export function createCatalogRunContext(options: { readonly outputDirectory?: string } = {}): CatalogRunContext {
  const startedAt = Date.now();
  const deadlineAt = startedAt + CATALOG_RUN_LIMITS.durationMs;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(CATALOG_RUN_LIMITS.durationMs)]);
  let budget: CatalogRunContext['budget'] = Object.freeze({ requests: 0, bytes: 0, exceeded: false });
  const failBudget = (): never => {
    budget = Object.freeze({ ...budget, exceeded: true });
    const error = new Error('marketCollectorBudgetExceeded');
    controller.abort(error);
    throw error;
  };
  const check = () => {
    if (signal.aborted || Date.now() >= deadlineAt || budget.exceeded) {
      failBudget();
    }
  };
  const checkCapacity = (requests: number, bytes: number) => {
    check();

    if (!Number.isSafeInteger(requests) || requests < 0 || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error('采集预算增量必须为非负安全整数');
    }

    if (budget.requests + requests > CATALOG_RUN_LIMITS.requests || budget.bytes + bytes > CATALOG_RUN_LIMITS.bytes) {
      failBudget();
    }
  };

  // 每次返回新的预算快照；不同构建不共享计数、取消信号或可变状态。
  return Object.freeze({
    outputDirectory: options.outputDirectory,
    startedAt,
    deadlineAt,
    signal,
    get budget() { return budget; },
    check,
    checkCapacity,
    failBudget,
    consumeRequest() {
      checkCapacity(1, 0);
      budget = Object.freeze({ ...budget, requests: budget.requests + 1 });
    },
    consumeBytes(bytes: number) {
      checkCapacity(0, bytes);
      budget = Object.freeze({ ...budget, bytes: budget.bytes + bytes });
    },
    requestSignal() {
      check();
      const remaining = Math.max(1, deadlineAt - Date.now());
      return AbortSignal.any([signal, AbortSignal.timeout(Math.min(CATALOG_RUN_LIMITS.requestTimeoutMs, remaining))]);
    },
    async measure<T>(stage: string, action: () => Promise<T>): Promise<T> {
      check();
      const phaseStartedAt = Date.now();

      try {
        const result = await action();
        check();
        return result;
      } finally {
        console.info(JSON.stringify({
          阶段: stage, 阶段耗时毫秒: Date.now() - phaseStartedAt,
          批次耗时毫秒: Date.now() - startedAt, 请求: budget.requests, 字节: budget.bytes,
        }));
      }
    },
  });
}
