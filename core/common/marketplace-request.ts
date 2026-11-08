// 独立市场核心快照：与主站同名模块同步规则，仅引用仓库内源码。
export type MarketplaceRequestErrorCode =
  | 'marketDirectoryRateLimited'
  | 'marketDirectoryForbidden'
  | 'marketDirectorySignIn'
  | 'marketDirectoryNotFound'
  | 'marketDirectoryTimeout'
  | 'marketDirectoryUnavailable'
  | 'marketDirectoryRequestRejected';

export class MarketplaceRequestError extends Error {
  constructor(
    readonly code: MarketplaceRequestErrorCode,
    readonly status?: number,
    readonly retryAt?: number,
    readonly source?: string,
    readonly stage?: 'manifest',
  ) {
    super(code);
    this.name = 'MarketplaceRequestError';
  }
}

export function getMarketplaceRetryAt(headers: Headers, now = Date.now()): number | undefined {
  const retryAfter = headers.get('retry-after');

  if (retryAfter) {
    const seconds = Number(retryAfter);
    const time = Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1000 : Date.parse(retryAfter);

    if (Number.isFinite(time) && time > now) {
      return time;
    }
  }

  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(headers.get('x-ratelimit-reset')) * 1000;

    if (Number.isFinite(reset) && reset > now) {
      return reset;
    }
  }

  return undefined;
}

export function classifyMarketplaceStatus(status: number, headers: Headers): MarketplaceRequestErrorCode {
  if (status === 429 || (status === 403 &&
    (headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after')))) {
    return 'marketDirectoryRateLimited';
  }

  if (status === 401) {
    return 'marketDirectorySignIn';
  }

  if (status === 403) {
    return 'marketDirectoryForbidden';
  }

  if (status === 404) {
    return 'marketDirectoryNotFound';
  }

  return 'marketDirectoryUnavailable';
}
