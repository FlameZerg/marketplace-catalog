import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  PUBLIC_CATALOG_LIMITS, publicCatalogIndexSchema, type PublicCatalogIndex,
  retainCompatiblePublicCatalogSources,
} from '../app/lib/marketplace/public-catalog-contract';
import { readResponseBytes, sha256 } from './network';
import { collectIndexReferences, verifyIndexFiles } from './artifacts';
import { mapWithConcurrency } from '../app/lib/marketplace/concurrency';
import { CATALOG_RUN_LIMITS, createCatalogRunContext, type CatalogRunContext } from './run-context';

// CI 缓存只是加速层；已发布静态索引才是成功批次与历史版本的可恢复依据。
export async function restorePublishedCatalog(
  output: string, value: string | undefined, context: CatalogRunContext = createCatalogRunContext(),
): Promise<PublicCatalogIndex | undefined> {
  if (!value) return undefined;
  const base = new URL(value.endsWith('/') ? value : `${value}/`);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('marketCollectorTargetInvalid');
  }
  const read = async (relative: string, limit: number, optional = false): Promise<Buffer | undefined> => {
    context.consumeRequest();
    const target = new URL(relative, base);
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) throw new Error('marketCollectorTargetInvalid');
    const response = await fetch(target, {
      method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-cache',
      signal: context.requestSignal(),
    });
    // 首次发布前目录缺失是明确的未发布状态，不冒充成功空市场。
    if (optional && response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('application/json')) {
      await response.body?.cancel();
      throw new Error('marketCollectorPublishedStateUnavailable');
    }
    return Buffer.from(await readResponseBytes(response, context, limit));
  };
  const currentBytes = await read('catalog-index.json', PUBLIC_CATALOG_LIMITS.indexBytes, true);
  if (!currentBytes) return undefined;
  const current = retainCompatiblePublicCatalogSources(publicCatalogIndexSchema.parse(JSON.parse(currentBytes.toString('utf8'))));
  const indexes = [current];
  const ids = [...new Set(current.previousReleases)].filter((id) => id !== current.releaseId);
  for (const id of ids) {
    context.check();
    const bytes = await read(`releases/${id}.json`, PUBLIC_CATALOG_LIMITS.indexBytes);
    const index = retainCompatiblePublicCatalogSources(publicCatalogIndexSchema.parse(JSON.parse(bytes!.toString('utf8'))));
    if (index.releaseId !== id) throw new Error('marketCollectorHistoryInvalid');
    indexes.push(index);
  }
  const references = collectIndexReferences(indexes, context);
  const files = [...references.values()];
  // 冷恢复先做容量预判，不能下载数千文件后才发现预算必然不足。
  context.checkCapacity(files.length, files.reduce((bytes, file) => bytes + file.bytes, 0));
  await mapWithConcurrency(files, CATALOG_RUN_LIMITS.ioConcurrency, async (file) => {
    context.check();
    const bytes = await read(file.path, file.bytes);
    if (!bytes || bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error('marketCollectorIntegrityFailed');
    const destination = path.join(output, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    context.check();
  });
  await mkdir(path.join(output, 'releases'), { recursive: true });
  for (const index of indexes) {
    await verifyIndexFiles(output, index, context);
    await writeFile(path.join(output, 'releases', `${index.releaseId}.json`), JSON.stringify(index));
  }
  // 全部内容通过校验后才恢复本地生产记录；失败不能触发重新全量采集。
  await writeFile(path.join(output, 'successful-releases.json'), JSON.stringify([current.releaseId, ...ids]));
  await writeFile(path.join(output, 'catalog-index.json'), JSON.stringify(current));
  context.check();
  return current;
}
