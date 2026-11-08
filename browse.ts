import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BROWSE_PAGE_SIZE, BROWSE_PAGE_GROUP_SIZE, BROWSE_SORTS, browseIndexSchema,
  browseSummarySchema, browseViewSchema, compareBrowseSummaries,
  type BrowseSource, type BrowseSummary,
} from './core/marketplace/browse-contract.ts';
import { assertPublicCatalogEntries, type PublicCatalogFile, type PublicCatalogIndex } from './core/marketplace/public-catalog-contract.ts';
import type { McpMarketplaceEntry } from './core/marketplace/types.ts';
import type { CatalogRunContext } from './run-context.ts';
import { sha256 } from './network.ts';

type WriteContent = (data: unknown, bucket: string) => Promise<PublicCatalogFile>;

// 与既有客户端指纹保持同一排序和 FNV-1a 算法，摘要列表不需要携带完整配置。
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
function configurationFingerprint(entry: McpMarketplaceEntry): string {
  if (entry.catalogFingerprint) return entry.catalogFingerprint;
  const value = JSON.stringify(entry.installOptions.map((option) => JSON.stringify(canonical({
    config: option.config, requiredHeaders: [...(option.requiredHeaders ?? [])].sort(),
    requiredEnvironmentVariables: [...(option.requiredEnvironmentVariables ?? [])].sort(),
  }))).sort());
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(value.charCodeAt(index))) * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

async function writeView(entries: BrowseSummary[], bucket: string, write: WriteContent, context: CatalogRunContext) {
  const pages: PublicCatalogFile[] = [];
  for (let offset = 0; offset < entries.length; offset += BROWSE_PAGE_SIZE) {
    context.check();
    pages.push(await write(entries.slice(offset, offset + BROWSE_PAGE_SIZE), bucket));
  }
  const groups: PublicCatalogFile[] = [];
  for (let offset = 0; offset < pages.length; offset += BROWSE_PAGE_GROUP_SIZE) {
    groups.push(await write(pages.slice(offset, offset + BROWSE_PAGE_GROUP_SIZE), bucket));
  }
  return write(browseViewSchema.parse({ total: entries.length, groups }), bucket);
}

// 已验证的原安装分片继续负责版本恢复；浏览产物只添加轻量摘要和字节范围引用。
export async function buildBrowseCatalog(
  output: string, index: PublicCatalogIndex, context: CatalogRunContext, write: WriteContent,
) {
  const sources: BrowseSource[] = [];
  for (const source of index.sources) {
    const bucket = `${source.sourceId}/${source.kind}`;
    const summaries: BrowseSummary[] = [];
    for (const file of source.shards) {
      context.check();
      const bytes = await readFile(path.join(output, file.path));
      if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error('marketCollectorIntegrityFailed');
      const entries: unknown = JSON.parse(bytes.toString('utf8'));
      assertPublicCatalogEntries(entries, source);
      // 分片由 JSON.stringify 生成；拒绝不同编码布局，避免给详情生成错误的字节偏移。
      if (JSON.stringify(entries) !== bytes.toString('utf8')) throw new Error('marketCollectorIntegrityFailed');
      let offset = 1;
      for (const entry of entries) {
        const text = JSON.stringify(entry);
        const size = Buffer.byteLength(text);
        const base = {
          id: entry.id, sourceId: entry.sourceId, sourceName: entry.sourceName,
          name: entry.name, description: entry.description.slice(0, 512), publisher: entry.publisher,
          trustLevel: entry.trustLevel, version: entry.version, digest: entry.digest,
          popularity: entry.popularity, popularityMetric: entry.popularityMetric,
          repository: entry.repository, tags: entry.tags.slice(0, 12).map((tag) => tag.slice(0, 128)),
          detail: { file, offset, bytes: size, sha256: sha256(text) },
        };
        if (entry.kind === 'skill') {
          if (entry.install.type !== 'github' || !source.manifests[entry.id]) throw new Error('marketPublicManifestMissing');
          summaries.push(browseSummarySchema.parse({
            ...base, kind: 'skill', identity: entry.identity, hasScripts: entry.hasScripts,
            packageDigest: entry.packageDigest,
            install: { owner: entry.install.owner, repository: entry.install.repository,
              revision: entry.install.revision, directory: entry.install.directory, manifest: source.manifests[entry.id] },
          }));
        } else {
          summaries.push(browseSummarySchema.parse({
            ...base, kind: 'mcp', transports: entry.transports, catalogFingerprint: configurationFingerprint(entry),
          }));
        }
        offset += size + 1;
        context.check();
      }
      if (offset !== file.bytes) throw new Error('marketCollectorIntegrityFailed');
    }
    if (summaries.length !== source.validCount) throw new Error('marketCollectorIntegrityFailed');
    const views: Record<string, PublicCatalogFile> = {};
    const protocols = source.kind === 'skill' ? ['all'] : ['stdio', 'sse', 'streamable-http'];
    for (const protocol of protocols) {
      const filtered = summaries.filter((entry) => entry.kind === 'skill' || entry.transports.includes(protocol as 'stdio' | 'sse' | 'streamable-http'));
      for (const sort of BROWSE_SORTS) {
        views[`${protocol}:${sort}`] = await writeView(
          [...filtered].sort((left, right) => compareBrowseSummaries(left, right, sort)), bucket, write, context,
        );
      }
    }
    // 搜索索引首次搜索才读取，200 条一片；首屏不会读取这些摘要。
    const searchChunks: PublicCatalogFile[] = [];
    for (let offset = 0; offset < summaries.length; offset += 200) {
      searchChunks.push(await write(summaries.slice(offset, offset + 200), bucket));
    }
    sources.push({
      sourceId: source.sourceId, kind: source.kind, sourceRef: source.sourceRef,
      lastSuccessAt: source.lastSuccessAt, attemptedAt: source.attemptedAt, coverage: source.coverage,
      // 当前页与恢复索引使用同一读取范围，保留失败前窗口的真实元数据。
      collection: source.collection,
      errorCode: source.errorCode, remoteCount: source.remoteCount, validCount: source.validCount,
      views, search: await write(searchChunks, bucket),
    });
  }
  return browseIndexSchema.parse({ format: 1, releaseId: index.releaseId, publishedAt: index.publishedAt, sources });
}
