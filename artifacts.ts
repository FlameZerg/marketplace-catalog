import { mkdir, mkdtemp, readFile, writeFile, cp, readdir, stat, lstat } from 'node:fs/promises';
import path from 'node:path';
import {
  PUBLIC_CATALOG_LIMITS, publicCatalogIndexSchema,
  assertPublicCatalogEntries, publicSkillManifestSchema,
  retainCompatiblePublicCatalogSources,
  type PublicCatalogIndex, type PublicCatalogFile,
} from '../app/lib/marketplace/public-catalog-contract';
import { sha256 } from './network';
import { createCatalogRunContext, type CatalogRunContext } from './run-context';

// 所有指针留在私有工作目录；线上索引只由一次完整静态部署切换。
export async function readOptionalJson(file: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export async function storeContent(
  output: string, data: unknown, bucket: string, context: CatalogRunContext,
): Promise<PublicCatalogFile> {
  context.check();
  const text = JSON.stringify(data);
  const bytes = Buffer.byteLength(text);
  if (bytes > PUBLIC_CATALOG_LIMITS.shardBytes) throw new Error('marketCollectorShardLimit');
  const hash = sha256(text);
  if (!/^[a-z\d-]+\/(?:skill|mcp)$/.test(bucket)) throw new Error('marketCollectorSourceInvalid');
  const relative = `content/${bucket}/${hash}.json`;
  await mkdir(path.join(output, 'content', bucket), { recursive: true });
  await writeFile(path.join(output, relative), text);
  context.check();
  return { path: relative, sha256: hash, bytes };
}
export async function verifyIndexFiles(
  output: string, index: PublicCatalogIndex, context: CatalogRunContext = createCatalogRunContext(),
): Promise<void> {
  for (const source of index.sources) {
    context.check();
    const ids = new Set<string>();
    for (const file of source.shards) {
      context.check();
      const bytes = await readFile(path.join(output, file.path));
      if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error('marketCollectorIntegrityFailed');
      const entries: unknown = JSON.parse(bytes.toString('utf8'));
      assertPublicCatalogEntries(entries, source);
      for (const entry of entries) {
        if (ids.has(entry.id)) throw new Error('marketCollectorIntegrityFailed');
        ids.add(entry.id);
        if (entry.kind === 'skill' && !source.manifests[entry.id]) throw new Error('marketPublicManifestMissing');
      }
    }
    if (ids.size !== source.validCount) throw new Error('marketCollectorIntegrityFailed');
    for (const [entryId, file] of Object.entries(source.manifests)) {
      context.check();
      const bytes = await readFile(path.join(output, file.path));
      if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error('marketCollectorIntegrityFailed');
      const manifest = publicSkillManifestSchema.parse(JSON.parse(bytes.toString('utf8')));
      if (!ids.has(entryId) || manifest.entryId !== entryId || manifest.sourceId !== source.sourceId ||
        manifest.revision !== source.sourceRef) throw new Error('marketPublicManifestInvalid');
    }
  }
  context.check();
}

// 恢复和组装使用同一引用闭包，冲突元数据必须在下载或发布前失败。
export function collectIndexReferences(
  indexes: readonly PublicCatalogIndex[], context: CatalogRunContext,
): ReadonlyMap<string, PublicCatalogFile> {
  const references = new Map<string, PublicCatalogFile>();
  for (const index of indexes) for (const source of index.sources) {
    for (const file of [...source.shards, ...Object.values(source.manifests)]) {
      context.check();
      const previous = references.get(file.path);
      if (previous && (previous.bytes !== file.bytes || previous.sha256 !== file.sha256)) {
        throw new Error('marketCollectorIntegrityFailed');
      }
      references.set(file.path, file);
    }
  }
  return references;
}

export async function assembleDeployment(
  root: string, output: string, input: PublicCatalogIndex, context: CatalogRunContext = createCatalogRunContext(),
): Promise<string> {
  context.check();
  const published = await readOptionalJson(path.join(output, 'successful-releases.json'));
  if (published !== undefined && (!Array.isArray(published) || published.some((id) => typeof id !== 'string' || !/^[\w.-]{1,100}$/.test(id)))) {
    throw new Error('marketCollectorHistoryInvalid');
  }
  const history = [...new Set((published as string[] | undefined) ?? [])].filter((id) => id !== input.releaseId).slice(0, 7);
  const index = { ...retainCompatiblePublicCatalogSources(input), previousReleases: history };
  await verifyIndexFiles(output, index, context);
  const indexes = [index];
  for (const releaseId of history) {
    context.check();
    const previous = retainCompatiblePublicCatalogSources(
      publicCatalogIndexSchema.parse(await readOptionalJson(path.join(output, 'releases', `${releaseId}.json`))));
    // 历史文件名与发布身份必须一致，禁止把错代索引装入当前引用闭包。
    if (previous.releaseId !== releaseId) throw new Error('marketCollectorHistoryInvalid');
    await verifyIndexFiles(output, previous, context);
    indexes.push(previous);
  }
  // 每次全新 staging 避免旧文件残留；清理仅计算引用闭包，不删除线上或用户文件。
  await mkdir(path.join(output, 'staging'), { recursive: true });
  const staging = await mkdtemp(path.join(output, 'staging', `${index.releaseId}-`));
  const references = collectIndexReferences(indexes, context);
  await mkdir(staging, { recursive: true });
  let bytes = Buffer.byteLength(JSON.stringify(index));
  let count = 4;
  for (const file of references.values()) {
    context.check();
    const target = path.join(staging, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(output, file.path), target);
    bytes += file.bytes;
    count += 1;
  }
  for (const release of indexes) {
    context.check();
    const text = JSON.stringify(release);
    const target = path.join(staging, 'releases', `${release.releaseId}.json`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
    count += 1; bytes += Buffer.byteLength(text);
  }
  for (const name of ['_headers', '_routes.json', '404.html']) {
    context.check();
    await cp(path.join(root, 'static', name), path.join(staging, name));
    bytes += (await stat(path.join(staging, name))).size;
  }
  if (count > PUBLIC_CATALOG_LIMITS.deploymentFiles || bytes > PUBLIC_CATALOG_LIMITS.deploymentBytes ||
    Buffer.byteLength(JSON.stringify(index)) > PUBLIC_CATALOG_LIMITS.indexBytes) throw new Error('marketCollectorDeploymentLimit');
  await writeFile(path.join(staging, 'catalog-index.json'), JSON.stringify(index));
  context.check();
  return staging;
}

const STATIC_ROOT_FILES = new Set(['catalog-index.json', '_headers', '_routes.json', '404.html']);
const CONTENT_FILE = /^content\/[a-z\d-]+\/(?:skill|mcp)\/[a-f\d]{64}\.json$/;
const RELEASE_FILE = /^releases\/[\w.-]{1,100}\.json$/;
const STATIC_DIRECTORY = /^(?:releases|content(?:\/[a-z\d-]+(?:\/(?:skill|mcp))?)?)$/;

async function inspectStaticTree(
  directory: string, prefix: string, context: CatalogRunContext,
): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    context.check();
    if (entry.isSymbolicLink()) throw new Error('公共产物禁止符号链接');
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!STATIC_DIRECTORY.test(relative)) throw new Error('公共产物包含未允许目录');
      const child = await inspectStaticTree(target, relative, context);
      count += child.count; bytes += child.bytes;
    } else {
      if (!entry.isFile() || !(STATIC_ROOT_FILES.has(relative) ||
        CONTENT_FILE.test(relative) || RELEASE_FILE.test(relative))) throw new Error('公共产物包含私有状态、源码或配置');
      count += 1; bytes += (await stat(target)).size;
    }
    if (count > PUBLIC_CATALOG_LIMITS.deploymentFiles || bytes > PUBLIC_CATALOG_LIMITS.deploymentBytes) throw new Error('marketCollectorDeploymentLimit');
  }
  return { count, bytes };
}

export async function inspectStatic(
  directory: string, context: CatalogRunContext = createCatalogRunContext(),
): Promise<{ count: number; bytes: number }> {
  context.check();
  const information = await lstat(directory);
  if (!information.isDirectory() || information.isSymbolicLink()) throw new Error('公共产物根目录不安全');
  const result = await inspectStaticTree(directory, '', context);
  for (const name of STATIC_ROOT_FILES) {
    if (!(await lstat(path.join(directory, name))).isFile()) throw new Error('公共产物缺少必要静态文件');
  }
  // 纯静态路由按结构验证而非 JSON 键顺序；必须排除全部 Functions 请求。
  const routes: unknown = JSON.parse(await readFile(path.join(directory, '_routes.json'), 'utf8'));
  if (!routes || typeof routes !== 'object' || Object.keys(routes).length !== 3 ||
    !('version' in routes) || routes.version !== 1 ||
    !('include' in routes) || !Array.isArray(routes.include) || routes.include.length !== 1 || routes.include[0] !== '/*' ||
    !('exclude' in routes) || !Array.isArray(routes.exclude) || routes.exclude.length !== 1 || routes.exclude[0] !== '/*') {
    throw new Error('公共目录必须排除全部 Functions 路由');
  }
  context.check();
  return result;
}
