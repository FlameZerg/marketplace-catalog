import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 本地模块显式携带扩展名，原生 Node 构建不再需要自定义解析器。
import { collectCatalog } from './collect.ts';
import { inspectStatic, verifyIndexFiles } from './artifacts.ts';
import { createCatalogRunContext, type CatalogRunContext } from './run-context.ts';

const root = path.dirname(fileURLToPath(import.meta.url));
const privateRoot = path.join(root, 'output');
const destination = path.join(root, 'dist');

async function inspectDirectoryIfPresent(directory: string): Promise<boolean> {
  try {
    const information = await lstat(directory);
    if (!information.isDirectory() || information.isSymbolicLink()) throw new Error('生成目录不是普通目录，禁止覆盖');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function promoteStaticOutput(
  staging: string, workdir: string, context: CatalogRunContext,
): Promise<void> {
  const relative = path.relative(path.join(workdir, 'staging'), staging);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('静态候选目录越界');
  const canonicalRoot = await realpath(root);
  const canonicalWorkdir = await realpath(workdir);
  if (!canonicalWorkdir.startsWith(`${canonicalRoot}${path.sep}output${path.sep}`) ||
    !(await realpath(staging)).startsWith(`${canonicalWorkdir}${path.sep}staging${path.sep}`)) {
    throw new Error('静态候选目录包含越界链接');
  }
  await inspectStatic(staging, context);
  const hasPrevious = await inspectDirectoryIfPresent(destination);
  const backup = path.join(workdir, 'previous-dist');
  if (hasPrevious) {
    // 仅接管通过白名单检查的旧生成目录；保留私有备份，不递归删除用户目录。
    await inspectStatic(destination, context);
    await rename(destination, backup);
  }
  try {
    context.check();
    await rename(staging, destination);
  } catch (error) {
    if (hasPrevious) {
      try { await rename(backup, destination); }
      catch (rollbackError) {
        throw new AggregateError([error, rollbackError], '静态目录切换失败，旧产物已保留在本批私有 previous-dist');
      }
    }
    throw error;
  }
}

async function buildPagesCatalog(): Promise<void> {
  // Pages 构建只使用固定私有根与全新批次目录，不信任旧检查点或外部输出路径。
  if (process.env.CATALOG_OUTPUT) throw new Error('Pages 构建不接受 CATALOG_OUTPUT，请使用固定市场输出目录');
  if (!process.env.GITHUB_TOKEN?.trim()) throw new Error('必须在市场 Pages 构建环境配置只读 GITHUB_TOKEN');
  const workdir = path.join(privateRoot, `build-${randomUUID()}`);
  const context = createCatalogRunContext({ outputDirectory: workdir });
  await inspectDirectoryIfPresent(privateRoot);
  await mkdir(privateRoot, { recursive: true });
  await mkdir(workdir);
  const result = await collectCatalog(context);
  await context.measure('固定 Pages 静态输出', async () => {
    await verifyIndexFiles(result.stagingDirectory, result.index, context);
    await promoteStaticOutput(result.stagingDirectory, workdir, context);
    await writeFile(path.join(workdir, 'deployment-state.json'), JSON.stringify({
      releaseId: result.index.releaseId, phase: 'prepared', pagesOutput: destination,
    }));
  });
  console.info(`市场静态构建已完成：${result.index.releaseId}；仅准备产物，实际发布结果请查看 Pages 部署记录`);
}

// 不调用 Wrangler、不写生产成功指针；非零退出阻止 Pages 发布失败或不完整产物。
try {
  await buildPagesCatalog();
} catch (error) {
  console.error('市场静态构建失败，生产版本不应切换：', error instanceof Error ? error.message : '未知构建错误');
  process.exitCode = 1;
}
