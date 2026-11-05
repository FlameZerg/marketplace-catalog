// 独立市场核心快照：与主站同名模块同步规则，仅引用仓库内源码。
import { isRecord } from '../common/type-guards.ts';
import { yieldToMain } from '../runtime/yield.ts';
import {
  buildJsDelivrFileUrl,
  fetchTextWithDigest,
  getFileName,
  MAX_MARKET_TEXT_CHARS,
  normalizePath,
  type GitHubRepositoryFile,
} from './catalog-files.client.ts';
import type { MarketplaceSource } from './types.ts';

const CLAUDE_MARKETPLACE_PATH = '.claude-plugin/marketplace.json';
const MAX_SKILL_CANDIDATES = 1_000;
const NON_RELEASE_DIRECTORIES = new Set([
  'test', 'tests', '__tests__', 'fixtures', 'evals', 'evaluations', 'examples', 'templates', '.system', '.experimental',
]);

function joinManifestPath(...parts: string[]): string {
  const fragments = parts.map((part) => {
    const fragment = part.trim().replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');

    return fragment === '.' || !fragment ? '' : normalizePath(fragment);
  });
  const joined = fragments.filter(Boolean).join('/');

  return joined ? normalizePath(joined) : '';
}

function collectDirectorySkills(directory: string, files: GitHubRepositoryFile[]): string[] {
  const prefix = directory ? `${directory}/` : '';
  const directSkill = files.find((file) => file.path.toLowerCase() === `${prefix}skill.md`.toLowerCase());

  // 单技能目录只收录自身；集合目录才扫描其子技能，避免把附带示例重复上架。
  if (directSkill) {
    return [directSkill.path];
  }

  const candidates = files
    .filter((file) => file.path.startsWith(prefix) && getFileName(file.path).toLowerCase() === 'skill.md')
    .map((file) => file.path);
  const packageDirectories = new Set(candidates.map((path) => path.slice(0, path.lastIndexOf('/'))));

  // 集合扫描止于技能包根目录；内部同名文档仍是附件，单独显式声明不受此过滤影响。
  return candidates.filter((path) => {
    let ancestorDirectory = path.slice(0, path.lastIndexOf('/'));

    while (ancestorDirectory.includes('/')) {
      ancestorDirectory = ancestorDirectory.slice(0, ancestorDirectory.lastIndexOf('/'));

      if (packageDirectories.has(ancestorDirectory)) {
        return false;
      }
    }

    return true;
  });
}

function collectDeclaredSkillPaths(plugin: Record<string, unknown>, files: GitHubRepositoryFile[]): string[] {
  if (typeof plugin.source !== 'string' || !/^(?:\.\/|\.?$)/.test(plugin.source)) {
    throw new Error('marketSkillManifestInvalid');
  }

  const rawSkills = plugin.skills;
  const declarations = rawSkills == null ? ['skills'] : typeof rawSkills === 'string' ? [rawSkills] : rawSkills;

  if (!Array.isArray(declarations) || declarations.some((path) => typeof path !== 'string')) {
    throw new Error('marketSkillManifestInvalid');
  }

  const sourceDirectory = plugin.source;

  return declarations.flatMap((declaration: string) => {
    const path = joinManifestPath(sourceDirectory, declaration);

    if (path && getFileName(path).toLowerCase() === 'skill.md') {
      // 声明的大小写可能与仓库不同，后续精确匹配必须使用索引中的真实路径。
      const exact = files.find((file) => file.path === path);

      if (exact) {
        return [exact.path];
      }

      const matches = files.filter((file) => file.path.toLowerCase() === path.toLowerCase());

      if (matches.length > 1) {
        throw new Error('marketSkillManifestInvalid');
      }

      return matches.map((file) => file.path);
    }

    return collectDirectorySkills(path, files);
  });
}

async function getPublisherDeclaredSkillPaths(
  source: MarketplaceSource,
  revision: string,
  files: GitHubRepositoryFile[],
  readText = fetchTextWithDigest,
): Promise<Set<string>> {
  const manifestPath = normalizePath(source.skillManifestPath ?? CLAUDE_MARKETPLACE_PATH);
  const manifestFile = files.find((file) => file.path === manifestPath);

  if (!manifestFile) {
    throw new Error('marketSkillManifestMissing');
  }

  const { content } = await readText(
    buildJsDelivrFileUrl(source.owner!, source.repository!, revision, manifestPath),
    manifestFile.hash,
  );

  if (content.length > MAX_MARKET_TEXT_CHARS) {
    throw new Error('marketSkillManifestInvalid');
  }

  const manifest: unknown = JSON.parse(content);

  if (!isRecord(manifest) || !Array.isArray(manifest.plugins)) {
    throw new Error('marketSkillManifestInvalid');
  }

  let declaredPaths: string[] = [];

  for (const plugin of manifest.plugins) {
    if (!isRecord(plugin)) {
      throw new Error('marketSkillManifestInvalid');
    }

    declaredPaths = [...declaredPaths, ...collectDeclaredSkillPaths(plugin, files)];
    await yieldToMain();
  }

  return new Set(declaredPaths);
}

export async function discoverSkillFiles(
  source: MarketplaceSource,
  revision: string,
  files: GitHubRepositoryFile[],
  readText = fetchTextWithDigest,
): Promise<GitHubRepositoryFile[]> {
  let declaredPaths: Set<string> | undefined;

  if (source.skillDiscovery === 'publisher-manifest') {
    declaredPaths = await getPublisherDeclaredSkillPaths(source, revision, files, readText);
  } else if (source.skillDiscovery === 'publisher-directories') {
    if (!source.skillDirectories?.length || source.skillDirectories.some((path) => !path.trim())) {
      throw new Error('marketSkillDirectoryMissing');
    }

    declaredPaths = new Set(source.skillDirectories.flatMap((path) => collectDirectorySkills(normalizePath(path), files)));
  } else if (source.trustLevel === 'official-publisher') {
    // 官方信任与发现范围绑定；缺失声明不能自动放宽为全仓库扫描。
    throw new Error('marketSkillManifestMissing');
  }

  const candidates = files.filter((file) =>
    getFileName(file.path).toLowerCase() === 'skill.md' &&
    (!declaredPaths || declaredPaths.has(file.path)) &&
    (source.trustLevel !== 'official-publisher' ||
      !file.path.split('/').slice(0, -1).some((segment) => NON_RELEASE_DIRECTORIES.has(segment.toLowerCase()))),
  );

  if (candidates.length === 0) {
    throw new Error('marketSkillDirectoryMissing');
  }

  // 超出安全边界时明确失败，而不是把前若干项伪装成完整目录。
  if (candidates.length > MAX_SKILL_CANDIDATES) {
    throw new Error('marketSkillCandidateLimit');
  }

  return [...new Map(candidates.map((file) => [file.path, file])).values()];
}
