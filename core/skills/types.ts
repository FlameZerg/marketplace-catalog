// 独立市场核心快照：与主站同名模块同步规则，仅引用仓库内源码。
export type SkillSource = 'manual' | 'file' | 'zip' | 'directory' | 'market';

export interface SkillMarketplaceMetadata {
  entryId: string;
  sourceId: string;
  sourceName: string;
  version?: string;
  digest?: string;
  repositoryUrl?: string;
  packageDigest?: string;
  trustLevel?: string;
  revision?: string;
  filesFingerprint?: string;
  identity?: string;
  /** 本地正文版本只用于修改冲突检测，不与市场 SHA 摘要直接比较。 */
  contentVersion?: string;
}

export interface SkillFileMetadata {
  path: string;
  size: number;
  isSkillMarkdown: boolean;
  kind?: 'text' | 'binary';
  hash?: string;
}

// 旧记录未带 kind 时仍是文本；二进制不经过 TextDecoder 或 Base64 存储。
export type SkillFileContent = SkillFileMetadata & (
  | { kind?: 'text'; content: string; blob?: never }
  | { kind: 'binary'; blob: Blob; content?: never }
);

export interface SkillImportPackage {
  markdown: string;
  source: SkillSource;
  files: SkillFileContent[];
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;

  /** Agent Skills 标准 frontmatter 可选字段。 */
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;

  /** frontmatter `when_to_use`：只进技能清单、不进正文，用于让模型判断何时该用该技能。 */
  whenToUse?: string;

  /** frontmatter `keywords`：本地预激活匹配用的显式关键词。 */
  keywords?: string[];
  content: string;
  source: SkillSource;
  marketplace?: SkillMarketplaceMetadata;
  files: SkillFileMetadata[];
  fileVersion?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ParsedSkillDefinition {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
  whenToUse?: string;
  keywords?: string[];
  content: string;
  source: SkillSource;
}

export type SkillUpsertAction = 'created' | 'updated';

export interface SkillUpsertResult {
  skill: SkillDefinition;
  action: SkillUpsertAction;
}
