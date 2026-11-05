// 独立市场核心快照：与主站同名模块同步规则，仅引用仓库内源码。
import type { MCPServerConfig } from '../common/mcp-config-schema.ts';
import type { McpCatalogCollection, PublicCatalogCoverage } from './mcp-collection-policy.ts';

// 市场标题作为新配置名称，刷新旧目录但保留已有安装关联。
export const MCP_MARKETPLACE_SCHEMA_VERSION = 9;

// 技能包发现边界与元数据兼容规则变化后，重新生成旧候选及其校验结果。
export const SKILL_MARKETPLACE_SCHEMA_VERSION = 6;

export type MarketplaceKind = 'skill' | 'mcp';
export type MarketplaceSourceType = 'github-skills' | 'mcp-registry' | 'modelscope-mcp' | 'manifest';
export type MarketplaceTrustLevel = 'official-publisher' | 'registry-namespace-verified' | 'platform-listed' | 'user-added';
export type SkillDiscoveryMode = 'publisher-manifest' | 'publisher-directories' | 'repository-scan';

export interface MarketplaceSource {
  id: string;
  kind: MarketplaceKind;
  type: MarketplaceSourceType;
  name: string;
  enabled: boolean;
  builtIn: boolean;
  trustLevel: MarketplaceTrustLevel;
  owner?: string;
  repository?: string;
  ref?: string;
  url?: string;
  skillDiscovery?: SkillDiscoveryMode;
  skillManifestPath?: string;

  // 无发布清单的官方仓库必须显式限定技能目录，不能退化为全仓库扫描。
  skillDirectories?: string[];
}

export interface MarketplaceRepository {
  owner: string;
  name: string;
  url: string;
  stars?: number;
  commitSha?: string;
}

interface MarketplaceEntryBase {
  // 存在此引用时条目只是浏览摘要，预览或安装前必须解析并校验单条详情。
  catalogDetail?: {
    file: { path: string; sha256: string; bytes: number };
    offset: number; bytes: number; sha256: string;
  };
  id: string;
  sourceId: string;
  sourceName: string;
  trustLevel: MarketplaceTrustLevel;
  name: string;
  description: string;
  publisher: string;
  version?: string;
  digest?: string;
  repository?: MarketplaceRepository;
  popularity: number;
  popularityMetric?: 'installs' | 'stars' | 'unknown';
  tags: string[];
  updatedAt?: string;
}

export interface GitHubSkillInstallPayload {
  type: 'github';
  owner: string;
  repository: string;
  revision: string;
  directory: string;
  // 清单引用来自受信静态目录，旧卡片仍绑定自己的固定提交，不借用最新清单。
  publicManifest?: { path: string; sha256: string; bytes: number };
  files: Array<{
    path: string;
    hash?: string;
  }>;
}

export interface ManifestSkillInstallPayload {
  type: 'manifest';
  files: Array<{
    path: string;
    url: string;
    hash?: string;
  }>;
}

export interface SkillMarketplaceEntry extends MarketplaceEntryBase {
  kind: 'skill';
  hasScripts: boolean;

  // 完整包摘要用于排除镜像重复项，不改变既有的主文档修改检测摘要。
  packageDigest?: string;
  validation?: { status: 'metadata' | 'verified' | 'failed'; error?: string };
  identity?: string;
  install: GitHubSkillInstallPayload | ManifestSkillInstallPayload;
}

export interface McpMarketplaceInstallOption {
  serverName: string;
  config: MCPServerConfig;
  requiresConfiguration: boolean;
  requiredHeaders?: string[];

  // 仅保存变量名；凭据值必须由用户在添加时填写并写入本地 MCP 配置。
  requiredEnvironmentVariables?: string[];
}

export interface McpMarketplaceEntry extends MarketplaceEntryBase {
  kind: 'mcp';
  transport?: MCPServerConfig['type'];
  transports: MCPServerConfig['type'][];

  // 每个选项都对应目录中可验证的完整配置；协议标签不参与安装配置推断。
  installOptions: McpMarketplaceInstallOption[];
  /** 弹窗预填本地凭据时保留原目录摘要，不能将凭据误当作上游变更。 */
  catalogFingerprint?: string;
}

export type MarketplaceEntry = SkillMarketplaceEntry | McpMarketplaceEntry;

export interface MarketplaceSourceSnapshot {
  sourceId: string;
  entries: MarketplaceEntry[];
  fetchedAt: string;
  // 公共快照状态与个人来源/安装数据隔离，保留真实采集时间和持久化结果。
  publicReleaseId?: string;
  publicPublishedAt?: string;
  publicCheckedAt?: number;
  publicContentKey?: string;
  publicCoverage?: PublicCatalogCoverage;
  // 公共目录独立保留读取范围，私有来源不受公共窗口策略影响。
  publicCollection?: McpCatalogCollection;
  publicAttemptedAt?: string;
  statisticsAt?: string;
  persistence?: 'memory' | 'persisted';
  storageError?: string;

  // 来源提交更新时使旧目录失效，避免在缓存有效期内继续展示旧版本。
  sourceRef?: string;
  schemaVersion?: number;
  issues?: Array<{ path: string; reason: string }>;
  error?: string;
  catalogProgress?: {
    fetched: number;
    total: number;
  };
  skillProgress?: {
    processed: number;
    total: number;
    skipped: number;
    complete: boolean;
  };
}

export interface MarketplaceInstallation {
  entryId: string;
  sourceId: string;
  kind: MarketplaceKind;
  installedId: string;

  // 仅保存规范化配置摘要，用于避免市场卸载误删用户后续修改的同名配置。
  configurationFingerprint?: string;
  version?: string;
  digest?: string;
  packageDigest?: string;
  enabled?: boolean;
  /** 固定提交与文件清单分开记录，避免仓库无关提交触发所有技能更新。 */
  revision?: string;
  filesFingerprint?: string;
  identity?: string;
  catalogFingerprint?: string;
  installedAt: string;
}

export type MarketplaceInstallationStatus =
  | 'not-installed'
  | 'installed'
  | 'update-available'
  | 'disabled'
  | 'source-unavailable'
  | 'locally-modified';

export type MarketplaceSortOrder = 'popular-desc' | 'popular-asc' | 'name-asc' | 'name-desc';
