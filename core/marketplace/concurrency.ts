// 独立市场核心快照：与主站同名模块同步规则，仅引用仓库内源码。
// 市场客户端与离线采集共用纯并发控制，不引入浏览器、网络或状态管理依赖。
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError('市场并发数必须为正整数');
  }

  const results: R[] = [];
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;

      try {
        results[index] = await mapper(items[index]);
      } catch (error) {
        failed = true;
        failure = error;
      }
    }
  });

  // 失败后停止派发，并收敛在途任务；结果始终按输入顺序返回。
  await Promise.all(workers);

  if (failed) {
    throw failure;
  }

  return results;
}
