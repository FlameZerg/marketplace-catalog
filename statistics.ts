// 离线入口只引用仓库内核心，独立 Pages 构建不依赖主站目录。
import type { MarketplaceEntry } from './core/marketplace/types.ts';
import { fetchJson, type CatalogNetworkContext } from './network.ts';
import { CATALOG_RUN_LIMITS, type CatalogRunContext } from './run-context.ts';

export type RepositoryStatisticsCollector = <T extends MarketplaceEntry>(entry: T) => Promise<T>;

const STATISTICS_LIMITS = {
  requests: 100, durationMs: 30_000, bytes: 2 * 1024 * 1024,
  reservedRequests: 100, reservedBytes: 8 * 1024 * 1024, reservedDurationMs: 30_000,
} as const;

// 去重与限流状态仅属于当前批次；不同来源共用，下一次构建重新创建。
export function createRepositoryStatisticsCollector(context: CatalogRunContext): RepositoryStatisticsCollector {
  const repositories = new Map<string, Promise<number | undefined>>();
  let rateLimited = false;
  let statisticsBudgetExhausted = false;
  let requests = 0;
  let bytes = 0;
  let deadlineAt: number | undefined;
  const checkStatisticsBudget = (additionalRequests = 0) => {
    context.check();
    const now = Date.now();
    // 只在第一次统计请求时开始计时，避免前面的技能采集消耗统计时间。
    deadlineAt ??= now + STATISTICS_LIMITS.durationMs;
    if (statisticsBudgetExhausted || now >= deadlineAt ||
      requests + additionalRequests > STATISTICS_LIMITS.requests || bytes >= STATISTICS_LIMITS.bytes ||
      context.deadlineAt - now <= STATISTICS_LIMITS.reservedDurationMs ||
      context.budget.requests + additionalRequests > CATALOG_RUN_LIMITS.requests - STATISTICS_LIMITS.reservedRequests ||
      context.budget.bytes > CATALOG_RUN_LIMITS.bytes - STATISTICS_LIMITS.reservedBytes) {
      if (!statisticsBudgetExhausted) console.warn('可选仓库统计预算已耗尽，剩余条目保留未知值');
      statisticsBudgetExhausted = true;
      throw new Error('marketCollectorStatisticsBudgetExceeded');
    }
  };
  const statisticsContext: CatalogNetworkContext = {
    check: checkStatisticsBudget,
    consumeRequest() {
      checkStatisticsBudget(1);
      context.consumeRequest();
      requests += 1;
    },
    consumeBytes(size) {
      // 已接收字节仍计入全局预算；局部上限只终止可选统计，不设置全局超限状态。
      context.consumeBytes(size);
      bytes += size;
      checkStatisticsBudget();
    },
    requestSignal() {
      checkStatisticsBudget();
      const remaining = Math.min(deadlineAt!, context.deadlineAt - STATISTICS_LIMITS.reservedDurationMs) - Date.now();
      return AbortSignal.any([context.requestSignal(), AbortSignal.timeout(Math.max(1, remaining))]);
    },
  };
  return async <T extends MarketplaceEntry>(entry: T): Promise<T> => {
    context.check();
    const repository = entry.repository;
    if (!repository || !/^[\w.-]+$/.test(repository.owner) || !/^[\w.-]+$/.test(repository.name)) return entry;
    const key = `${repository.owner}/${repository.name}`.toLowerCase();
    let pending = repositories.get(key);
    if (!pending) {
      if (rateLimited || statisticsBudgetExhausted) return entry;
      pending = fetchJson(`https://api.github.com/repos/${repository.owner}/${repository.name}`, statisticsContext).then((value) => {
        const stars = value && typeof value === 'object' ? (value as { stargazers_count?: unknown }).stargazers_count : undefined;
        if (typeof stars !== 'number' || !Number.isSafeInteger(stars) || stars < 0) throw new Error('marketCollectorStatisticsInvalid');
        return stars;
      }).catch((error: unknown) => {
        // 局部统计预算允许保留未知值，真正的全局取消或超限仍必须向上传播。
        context.check();
        if (error instanceof Error && error.message === 'marketCollectorBudgetExceeded') throw error;
        if (statisticsBudgetExhausted) return undefined;
        if (error instanceof Error && ['marketCollectorHttp403', 'marketCollectorHttp429'].includes(error.message)) {
          rateLimited = true;
        }
        console.error(`公共仓库统计不可用：${key}；保留未知值`);
        return undefined;
      });
      repositories.set(key, pending);
    }
    const stars = await pending;
    context.check();
    if (stars === undefined) return entry;
    // ModelScope 平台 Stars 与 GitHub Stars 分别保留，不修改调用方条目。
    return { ...entry, repository: { ...repository, stars },
      ...(entry.popularityMetric === 'unknown' ? { popularity: stars, popularityMetric: 'stars' as const } : {}) };
  };
}
