// 离线入口只引用仓库内核心，独立 Pages 构建不依赖主站目录。
import { parseSkillMarkdown } from './core/skills/parser.client.ts';
import { discoverSkillFiles } from './core/marketplace/skill-discovery.client.ts';
import { assertSkillPackagePaths, SKILL_PACKAGE_MAX_BYTES } from './core/skills/package-policy.ts';
import { SKILL_MARKETPLACE_SCHEMA_VERSION } from './core/marketplace/types.ts';
import type { MarketplaceSource, MarketplaceSourceSnapshot, SkillMarketplaceEntry } from './core/marketplace/types.ts';
import { publicSkillManifestSchema, type PublicSkillManifest } from './core/marketplace/public-catalog-contract.ts';
import { mapWithConcurrency } from './core/marketplace/concurrency.ts';
import { fetchBytes, fetchJson, sha256 } from './network.ts';
import { CATALOG_RUN_LIMITS, createCatalogRunContext, type CatalogRunContext } from './run-context.ts';
import { z } from 'zod';

const treeSchema = z.object({ truncated: z.boolean(), tree: z.array(z.object({
  path: z.string(), type: z.string(), mode: z.string(), sha: z.string(), size: z.number().optional(),
})) });
const cdnSchema = z.object({
  version: z.string(), files: z.array(z.object({
    name: z.string(), size: z.number().int().nonnegative(), hash: z.string().regex(/^[A-Za-z\d+/]{43}=$/),
  })).max(50_000),
});
export async function collectGitHub(source: MarketplaceSource, context: CatalogRunContext = createCatalogRunContext()): Promise<{
  snapshot: MarketplaceSourceSnapshot; manifests: PublicSkillManifest[]; remoteCount: number; excluded: Record<string, number>;
}> {
  const { owner, repository } = source;
  if (!owner || !repository) throw new Error('marketCollectorSourceInvalid');
  const api = `https://api.github.com/repos/${owner}/${repository}`;
  context.check();
  const repo = await fetchJson(api, context) as { stargazers_count?: number; default_branch?: string };
  const revision = source.ref && /^[a-f\d]{40}$/i.test(source.ref) ? source.ref
    : (await fetchJson(`${api}/commits/${encodeURIComponent(source.ref ?? repo.default_branch ?? 'HEAD')}`, context) as { sha?: string }).sha;
  if (!revision || !/^[a-f\d]{40}$/i.test(revision)) throw new Error('marketDirectoryRevisionMissing');
  const tree = treeSchema.parse(await fetchJson(`${api}/git/trees/${revision}?recursive=1`, context));
  if (tree.truncated || tree.tree.length > 50_000) throw new Error('marketSkillCandidateLimit');
  const cdn = cdnSchema.parse(await fetchJson(`https://data.jsdelivr.com/v1/packages/gh/${owner}/${repository}@${revision}?structure=flat`, context));
  if (cdn.version !== revision || new Set(cdn.files.map((file) => file.name)).size !== cdn.files.length) throw new Error('marketSkillIndexInvalid');
  const files = cdn.files.map((file) => ({ path: file.name.replace(/^\/+/, ''), size: file.size, hash: file.hash }));
  const candidates = await discoverSkillFiles(source, revision, files, async (url, expectedHash) => {
    const bytes = await fetchBytes(url, context, 100_000);
    if (!expectedHash || sha256(bytes) !== Buffer.from(expectedHash, 'base64').toString('hex')) throw new Error('skillPackageIntegrityFailed');
    return { content: Buffer.from(bytes).toString('utf8'), hash: expectedHash };
  });
  const gitByPath = new Map(tree.tree.map((file) => [file.path, file]));
  // 只并发独立 CDN 文件读取；GitHub API 仍串行，候选结果维持原始顺序。
  const results = await mapWithConcurrency(candidates, CATALOG_RUN_LIMITS.ioConcurrency, async (candidate) => {
    try {
      context.check();
      const directory = candidate.path.includes('/') ? candidate.path.slice(0, candidate.path.lastIndexOf('/')) : '';
      const prefix = directory ? `${directory}/` : '';
      const packageFiles = files.filter((file) => file.path.startsWith(prefix));
      const gitFiles = tree.tree.filter((file) => file.type !== 'tree' && file.path.startsWith(prefix));
      assertSkillPackagePaths(packageFiles.map((file) => file.path.slice(prefix.length)));
      if (gitFiles.length !== packageFiles.length || gitFiles.some((file) => file.type !== 'blob' || !['100644', '100755'].includes(file.mode)) ||
        packageFiles.reduce((total, file) => total + file.size, 0) > SKILL_PACKAGE_MAX_BYTES) throw new Error('skillPackageIntegrityFailed');
      const contentBytes = await fetchBytes(`https://cdn.jsdelivr.net/gh/${owner}/${repository}@${revision}/${candidate.path.split('/').map(encodeURIComponent).join('/')}`, context, 100_000);
      const content = Buffer.from(contentBytes).toString('utf8');
      const parsed = parseSkillMarkdown(content, 'market');
      const expected = Buffer.from(candidate.hash ?? '', 'base64').toString('hex');
      if (sha256(contentBytes) !== expected) throw new Error('skillPackageIntegrityFailed');
      const identity = `${owner}/${repository}/${candidate.path}`.toLowerCase();
      const entry: SkillMarketplaceEntry = {
        id: `${source.id}:${candidate.path.toLowerCase()}`, identity, sourceId: source.id, sourceName: source.name,
        trustLevel: source.trustLevel, kind: 'skill', name: parsed.name, description: parsed.description,
        publisher: owner, version: revision, digest: sha256(parsed.content), tags: parsed.keywords ?? [],
        popularity: repo.stargazers_count ?? 0, popularityMetric: repo.stargazers_count === undefined ? 'unknown' : 'stars',
        repository: { owner, name: repository, url: `https://github.com/${owner}/${repository}`, commitSha: revision, stars: repo.stargazers_count },
        hasScripts: packageFiles.some((file) => /\.(js|mjs|py|sh|ts)$/i.test(file.path)), validation: { status: 'metadata' },
        install: { type: 'github', owner, repository, revision, directory: directory || '.', files: packageFiles.map(({ path, hash }) => ({ path, hash })) },
      };
      // 完整构造并校验后再成对写入，避免无效候选留下孤立的条目或证明。
      const manifest = publicSkillManifestSchema.parse({
        format: 1, sourceId: source.id, entryId: entry.id, identity, owner, repository, revision, directory: directory || '.',
        files: packageFiles.map((file) => {
          const git = gitByPath.get(file.path);
          if (!git || git.size !== file.size || !/^[a-f\d]{40}$/i.test(git.sha)) throw new Error('skillPackageIntegrityFailed');
          return { path: file.path.slice(prefix.length), size: file.size, mode: git.mode as '100644' | '100755',
            sha256: Buffer.from(file.hash ?? '', 'base64').toString('hex'), gitBlob: git.sha };
        }),
      });
      context.check();
      return { entry, manifest };
    } catch (error) {
      // 预算失败属于整个批次；其他单包错误计入排除项，不能拖垮同源合法技能。
      context.check();
      if (error instanceof Error && error.message === 'marketCollectorBudgetExceeded') context.failBudget();
      console.warn(`跳过无效技能包：${source.id}/${candidate.path}`,
        error instanceof Error ? error.message : 'marketSkillPackageInvalid');
      return undefined;
    }
  });
  const entries = results.flatMap((result) => result ? [result.entry] : []);
  const manifests = results.flatMap((result) => result ? [result.manifest] : []);
  const invalidPackage = candidates.length - entries.length;
  return { snapshot: { sourceId: source.id, sourceRef: revision, entries, fetchedAt: new Date().toISOString(),
    schemaVersion: SKILL_MARKETPLACE_SCHEMA_VERSION,
    skillProgress: { processed: candidates.length, total: candidates.length, skipped: invalidPackage, complete: true } },
    manifests, remoteCount: candidates.length, excluded: invalidPackage ? { invalidPackage } : {} };
}
