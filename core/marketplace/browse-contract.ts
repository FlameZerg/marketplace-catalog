import { z } from 'zod';
import { publicCatalogFileSchema } from './public-catalog-contract.ts';
import type { MarketplaceSortOrder } from './types.ts';
import { compareMarketplaceEntries } from './entry-order.ts';
import { publicCatalogCoverageSchema, mcpCatalogCollectionSchema, isCatalogCollectionValid } from './mcp-collection-policy.ts';

// 浏览契约独立于完整安装契约；首页不携带正文、文件树或 MCP 配置。
export const BROWSE_PAGE_SIZE = 24;
export const BROWSE_PAGE_GROUP_SIZE = 64;
export const BROWSE_SORTS: readonly MarketplaceSortOrder[] = ['popular-desc', 'popular-asc', 'name-asc', 'name-desc'];
export const browseProtocolSchema = z.enum(['all', 'stdio', 'sse', 'streamable-http']);
export type BrowseProtocol = z.infer<typeof browseProtocolSchema>;
export const browseSliceSchema = z.object({
  file: publicCatalogFileSchema,
  offset: z.number().int().nonnegative(),
  bytes: z.number().int().positive().max(2_000_000),
  sha256: z.string().regex(/^[a-f\d]{64}$/),
}).refine((slice) => slice.offset + slice.bytes <= slice.file.bytes);

const base = z.object({
  id: z.string().min(1).max(1024), sourceId: z.string().min(1).max(128),
  sourceName: z.string().max(512), name: z.string().min(1).max(512),
  description: z.string().max(512), publisher: z.string().max(512),
  trustLevel: z.enum(['official-publisher', 'registry-namespace-verified', 'platform-listed', 'user-added']),
  version: z.string().max(512).optional(), digest: z.string().max(512).optional(),
  popularity: z.number().finite().nonnegative(),
  popularityMetric: z.enum(['installs', 'stars', 'unknown']).optional(),
  tags: z.array(z.string().max(128)).max(12),
  repository: z.object({
    owner: z.string().max(512), name: z.string().max(512),
    url: z.string().url().refine((value) => {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password;
    }),
    stars: z.number().int().nonnegative().optional(), commitSha: z.string().max(64).optional(),
  }).optional(),
  detail: browseSliceSchema,
});
export const browseSummarySchema = z.discriminatedUnion('kind', [
  base.extend({
    kind: z.literal('skill'), identity: z.string().max(2048), hasScripts: z.boolean(),
    packageDigest: z.string().max(512).optional(),
    install: z.object({
      owner: z.string().max(512), repository: z.string().max(512),
      revision: z.string().regex(/^[a-f\d]{40}$/i), directory: z.string().max(1024),
      manifest: publicCatalogFileSchema,
    }),
  }),
  base.extend({
    kind: z.literal('mcp'), transports: z.array(z.enum(['stdio', 'sse', 'streamable-http'])).min(1).max(3),
    catalogFingerprint: z.string().max(512),
  }),
]);
export type BrowseSummary = z.infer<typeof browseSummarySchema>;
export const browsePageSchema = z.array(browseSummarySchema).max(BROWSE_PAGE_SIZE);
export const browsePageGroupSchema = z.array(publicCatalogFileSchema).max(BROWSE_PAGE_GROUP_SIZE);
export const browseViewSchema = z.object({
  total: z.number().int().nonnegative().max(50_000),
  groups: z.array(publicCatalogFileSchema).max(1000),
}).refine((view) => view.groups.length === Math.ceil(view.total / BROWSE_PAGE_SIZE / BROWSE_PAGE_GROUP_SIZE));
export const browseSearchSchema = z.array(publicCatalogFileSchema).max(1000);
export const browseSourceSchema = z.object({
  sourceId: z.string(), kind: z.enum(['skill', 'mcp']), sourceRef: z.string().optional(),
  lastSuccessAt: z.string().datetime().nullable(), attemptedAt: z.string().datetime(),
  coverage: publicCatalogCoverageSchema, errorCode: z.string().optional(),
  collection: mcpCatalogCollectionSchema.optional(),
  remoteCount: z.number().int().nonnegative(), validCount: z.number().int().nonnegative(),
  views: z.record(publicCatalogFileSchema), search: publicCatalogFileSchema.optional(),
}).superRefine((source, context) => {
  const references = [...Object.values(source.views), ...(source.search ? [source.search] : [])];
  if (source.validCount > source.remoteCount ||
    (!source.lastSuccessAt && source.validCount > 0) ||
    // 轻量浏览索引与恢复索引使用相同覆盖语义，不能把窗口标为全量。
    (['complete', 'partial'].includes(source.coverage) && (!source.lastSuccessAt || source.errorCode)) ||
    !isCatalogCollectionValid(source) ||
    (source.coverage === 'unavailable' && source.lastSuccessAt !== null) ||
    (source.coverage === 'retained' && (!source.lastSuccessAt || !source.errorCode)) ||
    references.some((file) => !file.path.startsWith(`content/${source.sourceId}/${source.kind}/`) ||
      !file.path.endsWith(`/${file.sha256}.json`))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'marketPublicCatalogInvalid' });
  }
});
export const browseIndexSchema = z.object({
  format: z.literal(1), releaseId: z.string().regex(/^[\w.-]{1,100}$/),
  publishedAt: z.string().datetime(), sources: z.array(browseSourceSchema).max(30),
}).refine((index) => new Set(index.sources.map((source) => source.sourceId)).size === index.sources.length &&
  index.sources.reduce((total, source) => total + source.validCount, 0) <= 50_000);
export type BrowseIndex = z.infer<typeof browseIndexSchema>;
export type BrowseSource = z.infer<typeof browseSourceSchema>;

// 排序由构建和客户端搜索共用，固定 ID 打破同名、同热度的平局。
export function compareBrowseSummaries(left: BrowseSummary, right: BrowseSummary, sort: MarketplaceSortOrder): number {
  return compareMarketplaceEntries(left, right, sort);
}
