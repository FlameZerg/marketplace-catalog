import { z } from 'zod';

// 公共 MCP 的读取窗口是显式产品策略，不改变私有来源或安装配置。
export const MCP_COLLECTION_POLICY_VERSION = 1;
const REGISTRY_POLICY = Object.freeze({ policyVersion: MCP_COLLECTION_POLICY_VERSION, pageSize: 100, maxPages: 5 });
const MODELSCOPE_POLICY = Object.freeze({ policyVersion: MCP_COLLECTION_POLICY_VERSION, pageSize: 30, maxPages: 5 });

export function getMcpCollectionPolicy(sourceId: string) {
  if (sourceId === 'mcp-official-registry') return REGISTRY_POLICY;
  if (sourceId === 'mcp-modelscope') return MODELSCOPE_POLICY;
  return undefined;
}

export const publicCatalogCoverageSchema = z.enum(['complete', 'partial', 'retained', 'unavailable']);
export type PublicCatalogCoverage = z.infer<typeof publicCatalogCoverageSchema>;
export const mcpCatalogCollectionSchema = z.object({
  mode: z.literal('bounded'),
  // 历史记录保留自己的策略版本；本次验收另行严格匹配当前策略。
  policyVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  pageSize: z.number().int().min(1).max(100),
  maxPages: z.number().int().min(1).max(5),
  pagesFetched: z.number().int().min(1).max(5),
  hasMore: z.boolean(),
  // 上游未提供总数时保持缺省，已读数量不能充当平台总数。
  remoteTotal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict().refine((collection) => collection.pagesFetched <= collection.maxPages);
export type McpCatalogCollection = z.infer<typeof mcpCatalogCollectionSchema>;

export function isCurrentMcpCollection(sourceId: string, collection: McpCatalogCollection): boolean {
  const policy = getMcpCollectionPolicy(sourceId);
  return Boolean(policy && collection.policyVersion === policy.policyVersion &&
    collection.pageSize === policy.pageSize && collection.maxPages === policy.maxPages);
}

export function isCatalogCollectionValid(source: {
  readonly sourceId: string;
  readonly kind: 'skill' | 'mcp';
  readonly coverage: PublicCatalogCoverage;
  // 完整来源描述符总有计数；浏览器缓存缺失时只校验已知值，不能补造计数。
  readonly remoteCount?: number;
  readonly collection?: McpCatalogCollection;
}): boolean {
  const { collection, coverage, remoteCount } = source;
  if (remoteCount !== undefined && (!Number.isSafeInteger(remoteCount) || remoteCount < 0)) return false;
  if (source.kind === 'skill') return coverage !== 'partial' && collection === undefined;
  // 旧完整/保留描述符仍可恢复，但不能据缺失元数据推断部分覆盖。
  if (!collection) return coverage !== 'partial';
  // 此处只验证历史结构和计数，不让当前窗口参数破坏已发布版本恢复。
  if (coverage === 'unavailable' ||
    (remoteCount !== undefined && (remoteCount > collection.pageSize * collection.pagesFetched ||
      (collection.remoteTotal !== undefined && remoteCount > collection.remoteTotal)))) return false;
  if (collection.hasMore) {
    return coverage !== 'complete' && collection.pagesFetched === collection.maxPages &&
      (remoteCount === undefined || (remoteCount > 0 &&
        (collection.remoteTotal === undefined || remoteCount < collection.remoteTotal)));
  }
  return coverage !== 'partial' &&
    (remoteCount === undefined || collection.remoteTotal === undefined || remoteCount === collection.remoteTotal);
}
