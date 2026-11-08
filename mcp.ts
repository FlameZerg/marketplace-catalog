// 离线入口只引用仓库内核心，独立 Pages 构建不依赖主站目录。
import { parseRegistryEntry, mergeMcpMarketplaceEntries } from './core/marketplace/mcp-registry-parser.ts';
import { parseModelScopeEntry } from './core/marketplace/modelscope-mcp.client.ts';
import { MCP_MARKETPLACE_SCHEMA_VERSION } from './core/marketplace/types.ts';
import type { MarketplaceSource, MarketplaceSourceSnapshot, McpMarketplaceEntry } from './core/marketplace/types.ts';
import { isRecord } from './core/common/type-guards.ts';
import {
  getMcpCollectionPolicy, mcpCatalogCollectionSchema, type McpCatalogCollection,
} from './core/marketplace/mcp-collection-policy.ts';
import { fetchJson, sha256 } from './network.ts';
import { createRepositoryStatisticsCollector, type RepositoryStatisticsCollector } from './statistics.ts';
import { createCatalogRunContext, type CatalogRunContext } from './run-context.ts';

export async function collectMcp(
  source: MarketplaceSource,
  context: CatalogRunContext = createCatalogRunContext(),
  collectRepositoryStatistics: RepositoryStatisticsCollector = createRepositoryStatisticsCollector(context),
): Promise<{
  snapshot: MarketplaceSourceSnapshot; excluded: Record<string, number>; remoteCount: number;
  coverage: 'complete' | 'partial'; collection: McpCatalogCollection;
}> {
  const policy = getMcpCollectionPolicy(source.id);
  const registry = source.type === 'mcp-registry';
  if (!policy || source.kind !== 'mcp' ||
    (source.id === 'mcp-official-registry' ? !registry : source.type !== 'modelscope-mcp')) {
    throw new Error('marketCollectorSourceInvalid');
  }
  const accepted: McpMarketplaceEntry[] = [];
  const cursors = new Set<string>();
  const pages = new Set<string>();
  let remoteCount = 0;
  let excluded = 0;
  let cursor: string | undefined;
  let expectedTotal: number | undefined;
  let pagesFetched = 0;
  let hasMore = true;
  for (let page = 0; page < policy.maxPages; page += 1) {
    // 只访问明确批准的窗口；每页仍共享截止时间、响应限制和上游预算。
    context.check();
    const url = new URL(source.url!);
    if (registry) {
      url.searchParams.set('version', 'latest');
      url.searchParams.set('limit', String(policy.pageSize));
      if (cursor) url.searchParams.set('cursor', cursor);
    }
    const payload = await fetchJson(url.href, context, !registry ? {
      method: 'PUT',
      body: JSON.stringify({ PageNumber: page + 1, PageSize: policy.pageSize, Query: '',
        Criterion: [{ Category: 'Hosted', Predicate: 'contains', BoolValues: [true] }] }),
    } : undefined);
    if (!isRecord(payload)) throw new Error('marketCollectorPaginationInvalid');
    const data = isRecord(payload.Data) && isRecord(payload.Data.McpServer) ? payload.Data.McpServer : undefined;
    const rows = registry ? payload.servers : data?.McpServers;
    if (!Array.isArray(rows) || rows.length > policy.pageSize) throw new Error('marketCollectorPaginationInvalid');
    const signature = sha256(JSON.stringify(rows));
    if (rows.length && pages.has(signature)) throw new Error('marketCollectorPaginationLoop');
    pages.add(signature);
    if (!registry) {
      // 显式业务失败不能因 HTTP/Code 为 200 而成为窗口成功。
      if (payload.Code !== 200 || (payload.Success !== undefined && payload.Success !== true) ||
        !Number.isSafeInteger(data?.TotalCount) || Number(data?.TotalCount) < 0 ||
        (expectedTotal !== undefined && expectedTotal !== data?.TotalCount)) throw new Error('marketCollectorPaginationInvalid');
      expectedTotal = Number(data!.TotalCount);
    }
    remoteCount += rows.length;
    // 原始记录数量与有效条目分开计量，不把未访问记录算入排除项。
    if (remoteCount > policy.maxPages * policy.pageSize) throw new Error('marketCollectorSourceEntryLimit');
    for (const row of rows) {
      context.check();
      const entry = registry ? parseRegistryEntry(source, row) : parseModelScopeEntry(source, row);
      if (entry) accepted.push(entry); else excluded += 1;
    }
    const metadata = isRecord(payload.metadata) ? payload.metadata : undefined;
    if (registry && (!metadata || metadata.count !== rows.length ||
      (metadata.nextCursor !== undefined && typeof metadata.nextCursor !== 'string'))) {
      throw new Error('marketCollectorPaginationInvalid');
    }
    cursor = registry && typeof metadata?.nextCursor === 'string' ? metadata.nextCursor : undefined;
    hasMore = registry ? Boolean(cursor) : remoteCount !== expectedTotal;
    // 最后一页也必须先检查循环和提前空页，不能把异常响应包装成窗口成功。
    if (hasMore && (!rows.length || (cursor && cursors.has(cursor)) ||
      (expectedTotal !== undefined && remoteCount > expectedTotal))) throw new Error('marketCollectorPaginationLoop');
    if (cursor) cursors.add(cursor);
    pagesFetched = page + 1;
    if (!hasMore) break;
  }
  const collection = mcpCatalogCollectionSchema.parse({
    mode: 'bounded', ...policy, pagesFetched, hasMore,
    ...(expectedTotal !== undefined ? { remoteTotal: expectedTotal } : {}),
  });
  const merged = mergeMcpMarketplaceEntries(accepted);
  const entries: McpMarketplaceEntry[] = [];
  for (const entry of merged) entries.push(await collectRepositoryStatistics(entry));
  context.check();
  const coverage = hasMore ? 'partial' : 'complete';
  console.info('MCP 来源读取范围：', JSON.stringify({ 来源: source.id, 覆盖: coverage, 原始记录: remoteCount, 有效条目: entries.length, collection }));
  return { snapshot: { sourceId: source.id, schemaVersion: MCP_MARKETPLACE_SCHEMA_VERSION, entries,
    fetchedAt: new Date().toISOString(),
    ...(expectedTotal !== undefined ? { catalogProgress: { fetched: remoteCount, total: expectedTotal } } : {}) },
    coverage, collection, remoteCount,
    excluded: { unsupportedOrInactive: excluded, mergedTransportRecords: accepted.length - entries.length } };
}
