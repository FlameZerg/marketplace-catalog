// 独立市场核心快照：与主站同名模块同步规则，仅引用仓库内源码。
import { z } from 'zod';
import { BUILTIN_MARKETPLACE_SOURCES, getBuiltinMarketplaceSource } from './builtin-sources.ts';
import { MCP_MARKETPLACE_SCHEMA_VERSION, SKILL_MARKETPLACE_SCHEMA_VERSION } from './types.ts';
import type { MarketplaceEntry } from './types.ts';
import { mcpServerConfigSchema } from '../common/mcp-config-schema.ts';
import { assertSkillPackagePaths, normalizeSkillPackagePath, SKILL_PACKAGE_MAX_BYTES, SKILL_FILE_MAX_BYTES } from '../skills/package-policy.ts';
import { publicCatalogCoverageSchema, mcpCatalogCollectionSchema, isCatalogCollectionValid, isCurrentMcpCollection } from './mcp-collection-policy.ts';

// 预算同时约束字节、文件和条目，不能用 Content-Length 或静默截断代替完整校验。
export const PUBLIC_CATALOG_FORMAT = 1;
export const PUBLIC_CATALOG_LIMITS = {
  indexBytes: 512_000, shardBytes: 2_000_000, totalBytes: 64 * 1024 * 1024,
  entries: 50_000, shardEntries: 200, packageFiles: 1000, deploymentFiles: 15_000,
  deploymentBytes: 256 * 1024 * 1024, requestTimeoutMs: 30_000,
  checkIntervalMs: 15 * 60_000, staleAfterMs: 36 * 60 * 60_000,
} as const;
const digest = z.string().regex(/^[a-f\d]{64}$/);
const timestamp = z.string().datetime();
export const publicCatalogPathSchema = z.string().max(512).refine((value) =>
  /^[a-zA-Z\d._/-]+$/.test(value) && !value.startsWith('/') &&
  value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
);
export const publicCatalogFileSchema = z.object({
  path: publicCatalogPathSchema.refine((value) => /^content\/[a-z\d-]+\/(?:skill|mcp)\/[a-f\d]{64}\.json$/.test(value)),
  sha256: digest,
  bytes: z.number().int().nonnegative().max(PUBLIC_CATALOG_LIMITS.shardBytes),
});
export const publicCatalogSourceSchema = z.object({
  sourceId: z.string(), kind: z.enum(['skill', 'mcp']), schemaVersion: z.number().int(),
  sourceRef: z.string().optional(), lastSuccessAt: timestamp.nullable(), attemptedAt: timestamp,
  errorCode: z.string().max(200).optional(),
  coverage: publicCatalogCoverageSchema,
  collection: mcpCatalogCollectionSchema.optional(),
  remoteCount: z.number().int().nonnegative(), validCount: z.number().int().nonnegative(),
  excluded: z.record(z.number().int().nonnegative()),
  shards: z.array(publicCatalogFileSchema).max(1000),
  manifests: z.record(publicCatalogFileSchema).default({}),
}).superRefine((source, context) => {
  // 历史结构校验独立于当前构建的来源与版本，仍严格验证计数及文件引用。
  if (source.validCount > source.remoteCount || (!source.lastSuccessAt && source.validCount > 0) ||
    source.remoteCount - source.validCount !== Object.values(source.excluded).reduce((sum, count) => sum + count, 0) ||
    // 部分覆盖是正常完成批准窗口，仍须有成功时间且不能隐藏采集错误。
    (['complete', 'partial'].includes(source.coverage) && (!source.lastSuccessAt || source.errorCode)) ||
    !isCatalogCollectionValid(source) ||
    (source.coverage === 'unavailable' && (source.lastSuccessAt !== null || source.shards.length > 0)) ||
    (source.coverage === 'retained' && (!source.lastSuccessAt || !source.errorCode))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'marketPublicCatalogInvalid' });
  }
  if ([...source.shards, ...Object.values(source.manifests)].some((file) =>
    !file.path.startsWith(`content/${source.sourceId}/${source.kind}/`) ||
    !file.path.endsWith(`/${file.sha256}.json`))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'marketPublicCatalogInvalid' });
  }
});
export const publicCatalogIndexSchema = z.object({
  format: z.literal(PUBLIC_CATALOG_FORMAT), releaseId: z.string().regex(/^[\w.-]{1,100}$/),
  batchKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  plannedAt: timestamp, startedAt: timestamp, finishedAt: timestamp, publishedAt: timestamp,
  // 已成功发布的历史版本随小索引公开，CI 缓存失效后仍能恢复引用闭包和批次身份。
  previousReleases: z.array(z.string().regex(/^[\w.-]{1,100}$/)).max(7).default([]),
  sources: z.array(publicCatalogSourceSchema).max(30),
}).superRefine((index, context) => {
  if (new Set(index.sources.map((source) => source.sourceId)).size !== index.sources.length ||
    index.sources.reduce((sum, source) => sum + source.validCount, 0) > PUBLIC_CATALOG_LIMITS.entries ||
    index.sources.reduce((sum, source) => sum + source.shards.reduce((bytes, file) => bytes + file.bytes, 0), 0) > PUBLIC_CATALOG_LIMITS.totalBytes) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'marketPublicCatalogInvalid' });
  }
});
export type PublicCatalogIndex = z.infer<typeof publicCatalogIndexSchema>;
export type PublicCatalogSource = z.infer<typeof publicCatalogSourceSchema>;
export type PublicCatalogFile = z.infer<typeof publicCatalogFileSchema>;

// 首次与本批成功判定只接受本次完整采集或已校验的 MCP 窗口。
export function isPublicCatalogSourceReady(source: PublicCatalogSource): boolean {
  return Boolean(source.lastSuccessAt && !source.errorCode) &&
    (source.coverage === 'complete' || source.coverage === 'partial') && isCatalogCollectionValid(source) &&
    // 历史可读取不代表本次已完成当前政策，不能借旧策略绕过首次验收。
    (source.kind === 'skill' || (source.collection !== undefined && isCurrentMcpCollection(source.sourceId, source.collection)));
}

export function isPublicCatalogSourceCompatible(source: PublicCatalogSource): boolean {
  const builtin = getBuiltinMarketplaceSource(source.sourceId);
  return builtin?.kind === source.kind &&
    source.schemaVersion === (source.kind === 'skill' ? SKILL_MARKETPLACE_SCHEMA_VERSION : MCP_MARKETPLACE_SCHEMA_VERSION);
}

// 新批次仍必须覆盖当前内置来源；此规则不能用于解析历史发布。
export const currentPublicCatalogIndexSchema = publicCatalogIndexSchema.superRefine((index, context) => {
  if (index.sources.length !== BUILTIN_MARKETPLACE_SOURCES.length ||
    !index.sources.every(isPublicCatalogSourceCompatible) ||
    BUILTIN_MARKETPLACE_SOURCES.some((source) => !index.sources.some((item) => item.sourceId === source.id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'marketPublicCatalogInvalid' });
  }
});

export function retainCompatiblePublicCatalogSources(index: PublicCatalogIndex): PublicCatalogIndex {
  // 保留历史发布身份，不兼容描述符不参与内容恢复、完整性校验和部署引用闭包。
  return { ...index, sources: index.sources.map((source) => isPublicCatalogSourceCompatible(source) ? source : {
    sourceId: source.sourceId, kind: source.kind, schemaVersion: source.schemaVersion,
    lastSuccessAt: null, attemptedAt: source.attemptedAt, coverage: 'unavailable',
    errorCode: 'marketPublicCatalogUnavailable', remoteCount: 0, validCount: 0, excluded: {}, shards: [], manifests: {},
  }) };
}

export const publicSkillManifestSchema = z.object({
  format: z.literal(1), sourceId: z.string(), entryId: z.string(), identity: z.string(),
  owner: z.string(), repository: z.string(), revision: z.string().regex(/^[a-f\d]{40}$/i), directory: z.string(),
  files: z.array(z.object({
    path: z.string().refine((path) => { try { return normalizeSkillPackagePath(path) === path; } catch { return false; } }),
    mode: z.enum(['100644', '100755']), size: z.number().int().nonnegative().max(SKILL_FILE_MAX_BYTES),
    sha256: digest, gitBlob: z.string().regex(/^[a-f\d]{40}$/i),
  })).min(1).max(PUBLIC_CATALOG_LIMITS.packageFiles),
}).superRefine((manifest, context) => {
  try {
    assertSkillPackagePaths(manifest.files.map((file) => file.path));
    if (manifest.files.reduce((sum, file) => sum + file.size, 0) > SKILL_PACKAGE_MAX_BYTES) throw new Error();
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'marketPublicManifestInvalid' });
  }
});
export type PublicSkillManifest = z.infer<typeof publicSkillManifestSchema>;

export function assertPublicCatalogEntries(entries: unknown, source: Pick<PublicCatalogSource, 'sourceId' | 'kind'>): asserts entries is MarketplaceEntry[] {
  if (!Array.isArray(entries) || entries.length > PUBLIC_CATALOG_LIMITS.shardEntries) throw new Error('marketPublicCatalogInvalid');
  const builtin = getBuiltinMarketplaceSource(source.sourceId)!;
  if (!builtin) throw new Error('marketPublicCatalogInvalid');
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || entry.kind !== source.kind || entry.sourceId !== source.sourceId ||
      entry.sourceName !== builtin.name || entry.trustLevel !== builtin.trustLevel ||
      typeof entry.id !== 'string' || !entry.id.startsWith(`${source.sourceId}:`) ||
      typeof entry.name !== 'string' || typeof entry.description !== 'string' || typeof entry.publisher !== 'string' ||
      !entry.name.trim() || entry.name.length > 512 || entry.description.length > 100_000 ||
      entry.publisher.length > 512 || entry.id.length > 1024 ||
      !Number.isFinite(entry.popularity) || !Array.isArray(entry.tags) || entry.tags.some((tag: unknown) => typeof tag !== 'string')) {
      throw new Error('marketPublicCatalogInvalid');
    }
    if (entry.kind === 'skill' && (!entry.install || entry.install.type !== 'github' ||
      entry.install.owner !== builtin.owner || entry.install.repository !== builtin.repository ||
      !/^[a-f\d]{40}$/i.test(entry.install.revision) || !Array.isArray(entry.install.files) ||
      typeof entry.install.directory !== 'string')) {
      throw new Error('marketPublicCatalogInvalid');
    }
    if (entry.kind === 'skill') {
      if (typeof entry.hasScripts !== 'boolean') throw new Error('marketPublicCatalogInvalid');
      if (entry.install.publicManifest) publicCatalogFileSchema.parse(entry.install.publicManifest);
      if (entry.install.directory !== '.') normalizeSkillPackagePath(entry.install.directory);
      assertSkillPackagePaths(entry.install.files.map((file: { path: unknown; hash?: unknown }) => {
        if (typeof file.path !== 'string' || typeof file.hash !== 'string' || !/^[A-Za-z\d+/]{43}=$/.test(file.hash)) throw new Error('marketPublicCatalogInvalid');
        const prefix = entry.install.directory === '.' ? '' : `${entry.install.directory}/`;
        if (!file.path.startsWith(prefix)) throw new Error('marketPublicCatalogInvalid');
        return file.path.slice(prefix.length);
      }));
      const markdownPath = entry.install.directory === '.' ? 'skill.md' : `${entry.install.directory}/skill.md`;
      const markdown = entry.install.files.find((file: { path: string }) => file.path.toLowerCase() === markdownPath.toLowerCase());
      if (!markdown || entry.identity !== `${builtin.owner}/${builtin.repository}/${markdown.path}`.toLowerCase()) throw new Error('marketPublicCatalogInvalid');
    }
    if (entry.kind === 'mcp' && (!Array.isArray(entry.installOptions) || !Array.isArray(entry.transports) ||
      !entry.installOptions.every((option: { config?: { type?: string }; serverName?: unknown }) =>
        option && typeof option.serverName === 'string' && ['stdio', 'sse', 'streamable-http'].includes(option.config?.type ?? '')))) {
      throw new Error('marketPublicCatalogInvalid');
    }
    if (entry.kind === 'mcp') {
      if (!entry.installOptions.length || entry.transports.length > 3 ||
        entry.transports.some((type: unknown) => !['stdio', 'sse', 'streamable-http'].includes(String(type)))) {
        throw new Error('marketPublicCatalogInvalid');
      }
      for (const option of entry.installOptions) {
        const parsed = mcpServerConfigSchema.safeParse(option.config);
        if (!parsed.success || typeof option.requiresConfiguration !== 'boolean') throw new Error('marketPublicCatalogInvalid');
        if (parsed.data.type !== 'stdio') {
          const url = new URL(parsed.data.url);
          if (url.protocol !== 'https:' || url.username || url.password ||
            [...url.searchParams.keys()].some((key) => /key|token|secret|password|authorization/i.test(key)) ||
            Object.keys(parsed.data.headers ?? {}).length) throw new Error('marketPublicCatalogInvalid');
        } else if (Object.entries(parsed.data.env ?? {}).some(([key, value]) =>
          /key|token|secret|password|authorization/i.test(key) && value !== '')) throw new Error('marketPublicCatalogInvalid');
      }
    }
    if (entry.repository) {
      const repository = entry.repository;
      if (!repository || typeof repository.owner !== 'string' || typeof repository.name !== 'string' ||
        typeof repository.url !== 'string' ||
        (repository.stars !== undefined && (!Number.isSafeInteger(repository.stars) || repository.stars < 0))) {
        throw new Error('marketPublicCatalogInvalid');
      }
      const url = new URL(repository.url);
      if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password) {
        throw new Error('marketPublicCatalogInvalid');
      }
    }
  }
}
