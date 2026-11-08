// 独立市场核心快照：与主站同名模块同步规则，仅引用仓库内源码。
import { isRecord } from '../common/type-guards.ts';
import { createTimeoutSignal } from '../common/timeout-signal.ts';
import {
  MODELSCOPE_MCP_CATALOG_URL,
  MODELSCOPE_MCP_MAX_PAGES,
  MODELSCOPE_MCP_PAGE_SIZE,
  MODELSCOPE_MCP_PROXY_PATH,
} from '../common/modelscope-mcp.ts';
import { yieldToMain } from '../runtime/yield.ts';
import { assertPublicMcpRemoteUrl, normalizeMcpTransports, parseGitHubRepositoryUrl, parseMcpConfig } from './mcp-config.client.ts';
import { MCP_MARKETPLACE_SCHEMA_VERSION } from './types.ts';
import type { MarketplaceSource, MarketplaceSourceSnapshot, McpMarketplaceEntry } from './types.ts';

function getRequiredParameterNames(schema: unknown): string[] {
  if (!isRecord(schema) || !Array.isArray(schema.required)) {
    return [];
  }

  // EnvSchema 仅提供字段约束；目录层保存变量名，实际值由用户本地填写。
  return [...new Set(schema.required
    .filter((name): name is string => typeof name === 'string' && Boolean(name.trim()))
    .map((name) => name.trim()))];
}

function hasRequiredParameters(schema: unknown): boolean {
  return getRequiredParameterNames(schema).length > 0;
}

function parseRemoteConfig(value: unknown, transport: 'sse' | 'streamable-http') {
  if (!isRecord(value) || typeof value.url !== 'string' || value.command !== undefined) {
    return undefined;
  }

  try {
    const url = assertPublicMcpRemoteUrl(value.url);

    // 模板和带凭据的链接交由用户在平台配置，目录缓存不保存第三方密钥。
    if (url.protocol !== 'https:' || /[<>{}]/.test(decodeURIComponent(url.toString())) ||
      [...url.searchParams.keys()].some((key) => /key|token|secret|password|authorization/i.test(key))) {
      return undefined;
    }

    const config = parseMcpConfig({ type: transport, url: url.toString() });

    return config ? {
      config,
      requiredHeaders: isRecord(value.headers) ? Object.keys(value.headers) : [],
      requiresConfiguration: value.headers != null &&
        (!isRecord(value.headers) || Object.keys(value.headers).length > 0),
    } : undefined;
  } catch {
    return undefined;
  }
}

function findRemoteConfigs(item: Record<string, unknown>) {
  const resolvedRemotes: NonNullable<ReturnType<typeof parseRemoteConfig>>[] = [];
  const variants = [
    { value: item.StreamableHTTPServerConfig, schema: item.StreamableHTTPParameterSchema, type: 'streamable-http' as const },
    { value: item.SSEServerConfig, schema: item.SSEParameterSchema, type: 'sse' as const },
  ];

  for (const variant of variants) {
    let selectedRemote: ReturnType<typeof parseRemoteConfig> = undefined;

    if (!Array.isArray(variant.value)) {
      continue;
    }

    for (const configuration of variant.value) {
      if (!isRecord(configuration) || !isRecord(configuration.mcpServers)) {
        continue;
      }

      for (const candidate of Object.values(configuration.mcpServers)) {
        const remote = parseRemoteConfig(candidate, variant.type);

        if (remote) {
          const resolved = {
            ...remote,
            requiresConfiguration: remote.requiresConfiguration || hasRequiredParameters(variant.schema),
          };

          // 优先选择无需凭据的公开配置；只有配置型端点时保留平台引导入口。
          if (!resolved.requiresConfiguration) {
            selectedRemote = resolved;
            break;
          }

          selectedRemote ??= resolved;
        }
      }

      if (selectedRemote && !selectedRemote.requiresConfiguration) {
        break;
      }
    }

    if (selectedRemote) {
      resolvedRemotes.push(selectedRemote);
    }
  }

  return resolvedRemotes;
}

function findStdioConfig(item: Record<string, unknown>) {
  const variants = Array.isArray(item.ServerConfig) ? item.ServerConfig : [];
  const schemaRequiredNames = getRequiredParameterNames(item.EnvSchema);

  for (const variant of variants) {
    if (!isRecord(variant) || !isRecord(variant.mcpServers)) {
      continue;
    }

    for (const value of Object.values(variant.mcpServers)) {
      const config = parseMcpConfig(value);

      if (config?.type !== 'stdio' || /[<>{}]/.test([config.command, ...(config.args ?? [])].join('\n'))) {
        continue;
      }

      const templateEnvironmentNames = Object.entries(config.env ?? {})
        .filter(([name, value]) => /key|token|secret|password|authorization/i.test(name) || !value.trim() || /[<>{}]/.test(value))
        .map(([name]) => name);
      const requiredEnvironmentVariables = [...new Set([
        ...schemaRequiredNames,
        ...templateEnvironmentNames,
      ])];
      const requiredNames = new Set(requiredEnvironmentVariables);

      // 必填值统一清空后进入市场快照，防止空值或模板被误判为已完成配置。
      const sanitizedEnvironment = Object.fromEntries(
        Object.entries(config.env ?? {}).map(([name, value]) => [
          name,
          requiredNames.has(name) ? '' : value,
        ]),
      );

      return {
        config: {
          ...config,
          ...(Object.keys(sanitizedEnvironment).length > 0 ? { env: sanitizedEnvironment } : {}),
        },
        requiredEnvironmentVariables,
        requiresConfiguration: requiredEnvironmentVariables.length > 0,
      };
    }
  }

  return undefined;
}

export function parseModelScopeEntry(source: MarketplaceSource, value: unknown): McpMarketplaceEntry | undefined {
  if (!isRecord(value) || value.Hosted !== true || !Number.isSafeInteger(value.Id) ||
    typeof value.Path !== 'string' || typeof value.Name !== 'string') {
    return undefined;
  }

  const path = value.Path.trim();
  const name = value.Name.trim();

  if ((value.Id as number) <= 0 || !path || !name || path.length > 200 || name.length > 200 ||
    path === '.' || path === '..' || name === '.' || name === '..' || /[/\\\0]/.test(path + name)) {
    return undefined;
  }

  const remoteConfigs = findRemoteConfigs(value);
  const stdioConfig = findStdioConfig(value);
  const installOptions = [
    ...remoteConfigs.map((remote) => ({
      serverName: name,
      config: remote.config,
      requiredHeaders: remote.requiredHeaders,
      requiresConfiguration: remote.requiresConfiguration,
    })),
    ...(stdioConfig ? [{
      serverName: name,
      config: stdioConfig.config,
      requiredEnvironmentVariables: stdioConfig.requiredEnvironmentVariables,
      requiresConfiguration: stdioConfig.requiresConfiguration,
    }] : []),
  ];

  if (installOptions.length === 0) {
    return undefined;
  }

  const transports = normalizeMcpTransports(installOptions.map((option) => option.config.type));
  const repository = parseGitHubRepositoryUrl(value.FromSiteUrl);
  const description = [value.Abstract, value.OriginalAbstract, value.AbstractCN]
    .find((text): text is string => typeof text === 'string' && Boolean(text.trim()));
  const stars = typeof value.Stars === 'number' && Number.isFinite(value.Stars)
    ? Math.max(0, value.Stars)
    : undefined;

  return {
    id: `${source.id}:${value.Id}`,
    sourceId: source.id,
    sourceName: source.name,
    trustLevel: source.trustLevel,
    kind: 'mcp',
    name,
    description: description?.trim() || name,
    publisher: path,
    popularity: stars ?? 0,
    popularityMetric: stars === undefined ? 'unknown' : 'stars',
    tags: Array.isArray(value.Category) ? value.Category.filter((tag): tag is string => typeof tag === 'string') : [],
    repository: repository ? { owner: repository.owner, name: repository.repository, url: repository.url } : undefined,
    transport: transports[0],
    transports,
    installOptions,
  };
}

async function fetchModelScopePage(page: number): Promise<{ items: unknown[]; total: number }> {
  const timeout = createTimeoutSignal(undefined, 25_000);

  try {
    const response = await fetch(`${MODELSCOPE_MCP_PROXY_PATH}?page=${page}`, { signal: timeout.signal });

    if (!response.ok) {
      throw new Error(response.status === 401 ? 'marketModelScopeSignIn' : 'marketModelScopeUnavailable');
    }

    const payload: unknown = await response.json().catch(() => {
      throw new Error('marketModelScopeInvalidResponse');
    });
    const data = isRecord(payload) && payload.Code === 200 && isRecord(payload.Data) ? payload.Data.McpServer : undefined;

    if (!isRecord(data) || !Array.isArray(data.McpServers) ||
      typeof data.TotalCount !== 'number' || !Number.isSafeInteger(data.TotalCount) || data.TotalCount < 0) {
      throw new Error('marketModelScopeInvalidResponse');
    }

    return { items: data.McpServers, total: data.TotalCount };
  } catch (error) {
    // 网络、超时和流中断统一提供可翻译提示，协议错误保留精确原因。
    if (error instanceof Error && error.message.startsWith('marketModelScope')) {
      throw error;
    }

    throw new Error('marketModelScopeUnavailable');
  } finally {
    timeout.cleanup();
  }
}

export async function fetchModelScopeMcp(
  source: MarketplaceSource,
  onProgress: (snapshot: MarketplaceSourceSnapshot) => void,
): Promise<MarketplaceSourceSnapshot> {
  if (source.kind !== 'mcp' || source.url !== MODELSCOPE_MCP_CATALOG_URL) {
    throw new Error('marketModelScopeInvalidRequest');
  }

  let entries: McpMarketplaceEntry[] = [];
  let fetched = 0;
  let snapshot: MarketplaceSourceSnapshot = {
    sourceId: source.id,
    schemaVersion: MCP_MARKETPLACE_SCHEMA_VERSION,
    entries,
    fetchedAt: new Date().toISOString(),
  };

  for (let page = 1; page <= MODELSCOPE_MCP_MAX_PAGES; page += 1) {
    const result = await fetchModelScopePage(page);

    if (result.items.length > MODELSCOPE_MCP_PAGE_SIZE || fetched + result.items.length > result.total ||
      (!result.items.length && fetched < result.total)) {
      throw new Error('marketModelScopeInvalidResponse');
    }

    fetched += result.items.length;

    const accepted = result.items.map((item) => parseModelScopeEntry(source, item))
      .filter((entry): entry is McpMarketplaceEntry => Boolean(entry));
    entries = [...new Map([...entries, ...accepted].map((entry) => [entry.id, entry])).values()];
    snapshot = { ...snapshot, entries, catalogProgress: { fetched, total: result.total } };
    onProgress(snapshot);

    if (fetched >= result.total) {
      break;
    }

    await yieldToMain();
  }

  return snapshot;
}
