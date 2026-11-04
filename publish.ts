import { mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { publicCatalogIndexSchema } from '../app/lib/marketplace/public-catalog-contract';
import { inspectStatic, readOptionalJson, verifyIndexFiles } from './artifacts';

const project = process.env.CATALOG_PAGES_PROJECT;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const domain = process.env.CATALOG_PUBLIC_URL;
if (!project || !account || !domain || !process.env.CLOUDFLARE_API_TOKEN ||
  !/^[a-z\d-]+$/.test(project) || new URL(domain).protocol !== 'https:' ||
  process.env.CATALOG_TARGET_CONFIRMED !== 'true') throw new Error('独立目录目标尚未确认，禁止发布');
const output = path.resolve(process.env.CATALOG_OUTPUT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'output'));
const state = await readOptionalJson(path.join(output, 'deployment-state.json')) as { releaseId?: string; staging?: string } | undefined;
if (!state?.staging || !state.releaseId) throw new Error('未找到已验证公共产物');
const source = path.resolve(state.staging);
if (!source.startsWith(`${output}${path.sep}staging${path.sep}`)) throw new Error('公共产物目录越界');
const index = publicCatalogIndexSchema.parse(JSON.parse(await readFile(path.join(source, 'catalog-index.json'), 'utf8')));
if (index.releaseId !== state.releaseId) throw new Error('公共产物代次不匹配');
await inspectStatic(source);
await verifyIndexFiles(source, index);
const old = await readOptionalJson(path.join(output, 'catalog-index.json'));
if (old && publicCatalogIndexSchema.parse(old).releaseId === index.releaseId && process.env.CATALOG_REPUBLISH !== 'true') {
  console.info('该版本已成功发布，跳过重复上传。');
} else {
  // 仓库之外独立 cwd；配置与密钥不进入静态树，禁止主站 Functions 自动发现。
  const workdir = await mkdtemp(path.join(tmpdir(), 'marketplace-pages-'));
  await cp(source, path.join(workdir, 'static'), { recursive: true });
  await writeFile(path.join(workdir, 'wrangler.json'), JSON.stringify({ name: project, pages_build_output_dir: './static', compatibility_date: '2026-10-20' }));
  await writeFile(path.join(output, 'deployment-state.json'), JSON.stringify({ ...state, phase: 'publishing', attemptedAt: new Date().toISOString() }));
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx',
        // Pages 从独立工作目录自动发现配置，不接受 deploy 的 --config 参数。
        ['--yes', 'wrangler@4.98.0', 'pages', 'deploy', './static', '--project-name', project, '--branch', 'main'],
        { cwd: workdir, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: account }, stdio: ['ignore', 'pipe', 'pipe'],
          // Windows 的 npx.cmd 由系统 shell 启动；固定参数与严格项目名校验不接受任意命令。
          shell: process.platform === 'win32' });
      let bytes = 0;
      let failed = false;
      let tail = '';
      const timer = setTimeout(() => { failed = true; child.kill(); }, 10 * 60_000);
      const inspect = (chunk: Buffer) => {
        bytes += chunk.length;
        tail = `${tail}${chunk.toString('utf8')}`.slice(-8192);
        // 动态打包出现即中止上传，不在完成后才报告误发布。
        if (bytes > 8_000_000 || /(?:bundling|uploading|compiling).*(?:worker|functions)/i.test(tail)) {
          failed = true; child.kill();
        }
      };
      child.stdout.on('data', inspect);
      child.stderr.on('data', inspect);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 || failed) reject(new Error('静态发布失败或检测到动态打包'));
        else resolve();
      });
    });
    // 仅成功发布更新私有生产记录；失败重试仍复用候选产物，不重新抓取上游。
    const history = await readOptionalJson(path.join(output, 'successful-releases.json'));
    const published = Array.isArray(history) ? history.filter((id): id is string => typeof id === 'string') : [];
    await writeFile(path.join(output, 'successful-releases.json'), JSON.stringify([...new Set([index.releaseId, ...published])].slice(0, 8)));
    await writeFile(path.join(output, 'catalog-index.json'), JSON.stringify(index));
    await writeFile(path.join(output, 'deployment-state.json'), JSON.stringify({ ...state, phase: 'published', finishedAt: new Date().toISOString() }));
    console.info(`独立静态目录发布完成：${index.releaseId}`);
  } catch {
    await writeFile(path.join(output, 'deployment-state.json'), JSON.stringify({ ...state, phase: 'publish-failed', attemptedAt: new Date().toISOString() }));
    throw new Error('目录发布失败；已保留验证产物和阶段记录，生产指针未更新');
  }
}
