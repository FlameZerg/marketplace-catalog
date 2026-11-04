import { parseRegistryEntry, mergeMcpMarketplaceEntries } from '../app/lib/marketplace/mcp-registry-parser';
import { parseModelScopeEntry } from '../app/lib/marketplace/modelscope-mcp.client';
import { MCP_MARKETPLACE_SCHEMA_VERSION } from '../app/lib/marketplace/types';
import type { MarketplaceSource, MarketplaceSourceSnapshot, McpMarketplaceEntry } from '../app/lib/marketplace/types';
import { fetchJson, sha256 } from './network';
import { createRepositoryStatisticsCollector, type RepositoryStatisticsCollector } from './statistics';
import { createCatalogRunContext, type CatalogRunContext } from './run-context';

export async function collectMcp(
  source: MarketplaceSource,
  context: CatalogRunContext = createCatalogRunContext(),
  collectRepositoryStatistics: RepositoryStatisticsCollector = createRepositoryStatisticsCollector(context),
): Promise<{ snapshot: MarketplaceSourceSnapshot; excluded: Record<string, number>; remoteCount: number }> {
  const accepted: McpMarketplaceEntry[] = [];
  const cursors = new Set<string>();
  const pages = new Set<string>();
  let remoteCount = 0;
  let excluded = 0;
  let cursor: string | undefined;
  let expectedTotal: number | undefined;
  for (let page = 0; page < 500; page += 1) {
    // 游标与统计保持串行，所有页共享构建截止时间和上游请求预算。
    context.check();
    const url = new URL(source.url!);
    if (source.type === 'mcp-registry') {
      url.searchParams.set('version', 'latest');
      url.searchParams.set('limit', '100');
      if (cursor) url.searchParams.set('cursor', cursor);
    }
    const payload = await fetchJson(url.href, context, source.type === 'modelscope-mcp' ? {
      method: 'PUT',
      body: JSON.stringify({ PageNumber: page + 1, PageSize: 30, Query: '',
        Criterion: [{ Category: 'Hosted', Predicate: 'contains', BoolValues: [true] }] }),
    } : undefined) as {
      servers?: unknown[]; metadata?: { nextCursor?: string };
      Code?: number; Data?: { McpServer?: { McpServers?: unknown[]; TotalCount?: number } };
    };
    const data = payload.Data?.McpServer;
    const rows = source.type === 'mcp-registry' ? payload.servers : data?.McpServers;
    if (!Array.isArray(rows) || rows.length > 100) throw new Error('marketCollectorPaginationInvalid');
    const signature = sha256(JSON.stringify(rows));
    if (rows.length && pages.has(signature)) throw new Error('marketCollectorPaginationLoop');
    pages.add(signature);
    if (source.type !== 'mcp-registry') {
      if (payload.Code !== 200 || !Number.isSafeInteger(data?.TotalCount) || Number(data?.TotalCount) < 0 ||
        (expectedTotal !== undefined && expectedTotal !== data?.TotalCount)) throw new Error('marketCollectorPaginationInvalid');
      expectedTotal = data!.TotalCount!;
    }
    remoteCount += rows.length;
    // 条目数量属于来源边界，失败后由外层保留历史来源，不能取消其他来源的采集。
    if (remoteCount > 50_000) throw new Error('marketCollectorSourceEntryLimit');
    for (const row of rows) {
      context.check();
      const entry = source.type === 'mcp-registry' ? parseRegistryEntry(source, row) : parseModelScopeEntry(source, row);
      if (entry) accepted.push(entry); else excluded += 1;
    }
    if (payload.metadata?.nextCursor !== undefined && typeof payload.metadata.nextCursor !== 'string') {
      throw new Error('marketCollectorPaginationInvalid');
    }
    cursor = payload.metadata?.nextCursor;
    const complete = source.type === 'mcp-registry' ? !cursor : remoteCount === expectedTotal;
    if (complete) {
      const merged = mergeMcpMarketplaceEntries(accepted);
      const entries: McpMarketplaceEntry[] = [];
      for (const entry of merged) entries.push(await collectRepositoryStatistics(entry));
      context.check();
      return { snapshot: { sourceId: source.id, schemaVersion: MCP_MARKETPLACE_SCHEMA_VERSION, entries,
        fetchedAt: new Date().toISOString(), catalogProgress: { fetched: remoteCount, total: remoteCount } },
        remoteCount, excluded: { unsupportedOrInactive: excluded, mergedTransportRecords: accepted.length - entries.length } };
    }
    if (!rows.length || (cursor && cursors.has(cursor)) || (expectedTotal !== undefined && remoteCount > expectedTotal)) throw new Error('marketCollectorPaginationLoop');
    if (cursor) cursors.add(cursor);
  }
  throw new Error('marketCollectorPaginationLimit');
}
