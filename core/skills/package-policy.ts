// 独立市场核心快照：与主站同名模块同步规则，仅引用仓库内源码。
// 目录展示与安装预算分离；超过安装预算必须明确失败，不能截断文件后报告成功。
export const SKILL_PACKAGE_MAX_FILES = 1_000;
export const SKILL_PACKAGE_MAX_BYTES = 32 * 1024 * 1024;
export const SKILL_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const SKILL_MARKDOWN_MAX_CHARS = 100_000;

export function normalizeSkillPackagePath(value: string): string {
  const path = value.replace(/\\/g, '/');

  if (!path || path !== path.trim() || path.startsWith('/') || /[\0-\x1f<>:"|?*]/.test(path)) {
    throw new Error('skillPackageUnsafePath');
  }

  const segments = path.split('/');

  if (segments.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('skillPackageUnsafePath');
  }

  return path;
}

export function assertSkillPackagePaths(paths: string[]): void {
  if (!paths.length || paths.length > SKILL_PACKAGE_MAX_FILES) {
    throw new Error('skillPackageTooLarge');
  }

  const seen = new Set<string>();

  for (const path of paths) {
    const normalized = normalizeSkillPackagePath(path).normalize('NFC').toLowerCase();

    if (seen.has(normalized)) {
      throw new Error('skillPackageDuplicatePath');
    }

    seen.add(normalized);
  }

  for (const path of seen) {
    const parts = path.split('/');

    for (let end = 1; end < parts.length; end += 1) {
      if (seen.has(parts.slice(0, end).join('/'))) {
        throw new Error('skillPackageDuplicatePath');
      }
    }
  }
}
