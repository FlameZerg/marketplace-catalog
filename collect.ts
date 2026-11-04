import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_MARKETPLACE_SOURCES } from '../app/lib/marketplace/builtin-sources';
import {
  MCP_MARKETPLACE_SCHEMA_VERSION, SKILL_MARKETPLACE_SCHEMA_VERSION, type MarketplaceSource,
} from '../app/lib/marketplace/types';
import {
  PUBLIC_CATALOG_FORMAT, PUBLIC_CATALOG_LIMITS, publicCatalogSourceSchema,
  publicSkillManifestSchema, assertPublicCatalogEntries, type PublicCatalogIndex, type PublicCatalogSource,
  currentPublicCatalogIndexSchema, isPublicCatalogSourceCompatible,
} from '../app/lib/marketplace/public-catalog-contract';
import { collectGitHub } from './github';
import { collectMcp } from './mcp';
import { assembleDeployment, readOptionalJson, storeContent } from './artifacts';
import { restorePublishedCatalog } from './restore';
import { createCatalogRunContext, type CatalogRunContext } from './run-context';
import { createRepositoryStatisticsCollector, type RepositoryStatisticsCollector } from './statistics';

const root = path.dirname(fileURLToPath(import.meta.url));

export interface CatalogCollectionResult {
  readonly index: PublicCatalogIndex;
  readonly stagingDirectory: string;
  readonly outputDirectory: string;
  readonly reusedPublishedBatch: boolean;
}

async function collectSource(
  source: MarketplaceSource, output: string, context: CatalogRunContext, statistics: RepositoryStatisticsCollector,
): Promise<PublicCatalogSource> {
  const attemptedAt = new Date().toISOString();
  const skill = source.kind === 'skill' ? await collectGitHub(source, context) : undefined;
  const mcp = source.kind === 'mcp' ? await collectMcp(source, context, statistics) : undefined;
  const snapshot = skill?.snapshot ?? mcp!.snapshot;
  let descriptor: PublicCatalogSource = {
    sourceId: source.id, kind: source.kind, schemaVersion: snapshot.schemaVersion!, sourceRef: snapshot.sourceRef,
    lastSuccessAt: snapshot.fetchedAt, attemptedAt, coverage: 'complete',
    remoteCount: mcp?.remoteCount ?? skill!.remoteCount, validCount: snapshot.entries.length,
    excluded: mcp?.excluded ?? skill!.excluded, shards: [], manifests: {},
  };
  let shard: typeof snapshot.entries = [];
  let shardBytes = 2;
  const publishedEntryIds = new Set<string>();
  const flush = async () => {
    context.check();
    if (!shard.length) return;
    const file = await storeContent(output, shard, `${source.id}/${source.kind}`, context);
    descriptor = { ...descriptor, shards: [...descriptor.shards, file] };
    shard = [];
    shardBytes = 2;
  };
  for (const entry of snapshot.entries) {
    context.check();
    try {
      // 保留现有逐条拒绝策略，不让一个不合规条目破坏同来源的合法内容。
      assertPublicCatalogEntries([entry], descriptor);
    } catch {
      descriptor = { ...descriptor, validCount: descriptor.validCount - 1,
        excluded: { ...descriptor.excluded, contractRejected: (descriptor.excluded.contractRejected ?? 0) + 1 } };
      console.warn(`已跳过不符合公共契约的目录条目：${source.id}/${entry.id}`);
      continue;
    }
    const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (bytes + 2 > PUBLIC_CATALOG_LIMITS.shardBytes) throw new Error('marketCollectorShardLimit');
    if (shard.length >= PUBLIC_CATALOG_LIMITS.shardEntries || shardBytes + bytes > PUBLIC_CATALOG_LIMITS.shardBytes) await flush();
    shard = [...shard, entry];
    shardBytes += bytes;
    publishedEntryIds.add(entry.id);
  }
  await flush();
  const manifests: Array<readonly [string, Awaited<ReturnType<typeof storeContent>>]> = [];
  for (const manifest of skill?.manifests ?? []) {
    context.check();
    // 条目与安装证明必须成对发布，拒绝条目不能留下孤立证明。
    if (!publishedEntryIds.has(manifest.entryId)) continue;
    const file = await storeContent(output, publicSkillManifestSchema.parse(manifest), `${source.id}/${source.kind}`, context);
    manifests.push([manifest.entryId, file]);
  }
  return publicCatalogSourceSchema.parse({ ...descriptor, manifests: Object.fromEntries(manifests) });
}

async function collectSources(
  output: string, releaseId: string, previous: PublicCatalogIndex | undefined, context: CatalogRunContext,
): Promise<PublicCatalogSource[]> {
  const statistics = createRepositoryStatisticsCollector(context);
  const checkpoint = path.join(output, 'batches', releaseId);
  await mkdir(checkpoint, { recursive: true });
  const sources: PublicCatalogSource[] = [];
  for (const source of BUILTIN_MARKETPLACE_SOURCES) {
    context.check();
    const attemptedAt = new Date().toISOString();
    let descriptor: PublicCatalogSource;
    try {
      descriptor = await context.measure(`采集来源 ${source.id}`, () => collectSource(source, output, context, statistics));
    } catch (error) {
      context.check();
      if (error instanceof Error && error.message === 'marketCollectorBudgetExceeded') context.failBudget();
      const code = error instanceof Error && /^\w+$/.test(error.message) ? error.message : 'marketCollectorSourceFailed';
      const old = previous?.sources.find((item) => item.sourceId === source.id && isPublicCatalogSourceCompatible(item));
      descriptor = old?.lastSuccessAt ? { ...old, coverage: 'retained', attemptedAt, errorCode: code } : {
        sourceId: source.id, kind: source.kind,
        schemaVersion: source.kind === 'skill' ? SKILL_MARKETPLACE_SCHEMA_VERSION : MCP_MARKETPLACE_SCHEMA_VERSION,
        lastSuccessAt: null, attemptedAt, coverage: 'unavailable', errorCode: code,
        remoteCount: 0, validCount: 0, excluded: {}, shards: [], manifests: {},
      };
      console.error(`来源采集失败，保留上次成功时间：${source.id} ${code}`);
    }
    const validated = publicCatalogSourceSchema.parse(descriptor);
    // 检查点仅供本次构建诊断，不能冒充已经发布或跨构建持久化的状态。
    await writeFile(path.join(checkpoint, `${source.id}.json`), JSON.stringify(validated));
    sources.push(validated);
  }
  if (!previous && sources.some((source) => source.coverage !== 'complete')) {
    throw new Error('首次完整快照尚未就绪，不切换公共市场');
  }
  if (!sources.some((source) => source.coverage === 'complete')) {
    throw new Error('本批全部来源失败，保留生产版本且停止发布');
  }
  context.check();
  return sources;
}

export async function collectCatalog(context: CatalogRunContext): Promise<CatalogCollectionResult> {
  context.check();
  const privateRoot = path.join(root, 'output');
  const output = path.resolve(context.outputDirectory ?? process.env.CATALOG_OUTPUT ?? privateRoot);
  const relative = path.relative(privateRoot, output);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('采集工作目录必须位于市场私有 output 目录内');
  const publicUrl = process.env.CATALOG_PUBLIC_URL;
  if (!publicUrl) throw new Error('必须配置市场 Pages 的正式 CATALOG_PUBLIC_URL，不能使用预览部署地址');
  if (process.env.CATALOG_FORCE && !['true', 'false'].includes(process.env.CATALOG_FORCE)) {
    throw new Error('CATALOG_FORCE 只能为 true 或 false');
  }
  const forced = process.env.CATALOG_FORCE === 'true';
  const startedAt = new Date(context.startedAt).toISOString();
  const batchKey = new Date(context.startedAt + 8 * 3600_000).toISOString().slice(0, 10);
  const releaseId = `${batchKey}-${context.startedAt.toString(36)}`;
  const localPrevious = await readOptionalJson(path.join(output, 'catalog-index.json'));
  const previous = await context.measure('恢复生产静态版本', () => restorePublishedCatalog(output, publicUrl, context));
  if (!previous && localPrevious) throw new Error('生产索引缺失但本地存在成功记录，禁止作为首次发布继续采集');
  await mkdir(output, { recursive: true });
  // 只把已发布生产索引视为成功依据，未发布候选不能抢占本日幂等状态。
  const reusable = !forced && previous?.batchKey === batchKey && currentPublicCatalogIndexSchema.safeParse(previous).success;
  let index: PublicCatalogIndex;
  if (reusable) {
    index = currentPublicCatalogIndexSchema.parse(previous);
    console.info('该北京时间批次已有兼容生产版本，跳过全量采集并重新校验静态产物');
  } else {
    const sources = await collectSources(output, releaseId, previous, context);
    const finishedAt = new Date().toISOString();
    index = currentPublicCatalogIndexSchema.parse({
      format: PUBLIC_CATALOG_FORMAT, releaseId, batchKey, startedAt,
      plannedAt: new Date(`${batchKey}T00:00:00+08:00`).toISOString(),
      // publishedAt 保留旧协议兼容值，不作为真实部署时间或部署成功证明。
      finishedAt, publishedAt: finishedAt, sources,
      previousReleases: previous ? [...new Set([previous.releaseId, ...previous.previousReleases])].slice(0, 7) : [],
    });
  }
  const staging = await context.measure('校验并组装静态产物', () => assembleDeployment(root, output, index, context));
  // 组装会按已恢复的成功记录规范化历史；返回值和私有候选必须与实际静态索引一致。
  index = currentPublicCatalogIndexSchema.parse(await readOptionalJson(path.join(staging, 'catalog-index.json')));
  await mkdir(path.join(output, 'releases'), { recursive: true });
  await writeFile(path.join(output, `releases/${index.releaseId}.json`), JSON.stringify(index));
  await writeFile(path.join(output, 'candidate-index.json'), JSON.stringify(index));
  // 这里只确认产物准备完成，真正部署由 Pages 在构建成功后执行。
  await writeFile(path.join(output, 'deployment-state.json'), JSON.stringify({
    releaseId: index.releaseId, staging, phase: 'validated',
  }));
  context.check();
  return { index, stagingDirectory: staging, outputDirectory: output, reusedPublishedBatch: Boolean(reusable) };
}

// 旧手动入口保留至新链路验收后退役；作为库导入不会启动采集或触碰文件。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await collectCatalog(createCatalogRunContext());
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `staging=${result.stagingDirectory}\n`, { flag: 'a' });
  }
  console.info(`市场静态产物已校验：${result.index.releaseId}；尚未确认平台部署`);
}
