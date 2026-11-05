// 独立市场核心快照：与主站同名模块同步规则，仅引用仓库内源码。
import { isRecord } from '../common/type-guards.ts';
import { assertPublicMcpRemoteUrl, normalizeMcpTransports, parseGitHubRepositoryUrl, parseMcpConfig } from './mcp-config.client.ts';
import type { MarketplaceSource, McpMarketplaceEntry, McpMarketplaceInstallOption } from './types.ts';

function hasVariables(value: unknown): boolean {
  return (Array.isArray(value) && value.length > 0) || (isRecord(value) && Object.keys(value).length > 0);
}
function remoteOption(value: unknown, serverName: string): McpMarketplaceInstallOption | undefined {
  if (!isRecord(value) || typeof value.url !== 'string' || !['sse', 'streamable-http'].includes(String(value.type))) return undefined;
  try {
    const url = assertPublicMcpRemoteUrl(value.url);
    if ([...url.searchParams.keys()].some((key) => /key|token|secret|password|authorization/i.test(key))) return undefined;
    const config = parseMcpConfig({ type: value.type, url: url.href });
    if (!config || config.type === 'stdio') return undefined;
    const requiredHeaders = Array.isArray(value.headers)
      ? value.headers.flatMap((header) => isRecord(header) && typeof header.name === 'string' && header.name.trim() ? [header.name.trim()] : []) : [];
    return { serverName, config, requiredHeaders,
      requiresConfiguration: requiredHeaders.length > 0 || hasVariables(value.variables) || /[<>{}]/.test(decodeURIComponent(url.href)) };
  } catch { return undefined; }
}
function argumentsList(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const argument of value) {
    if (!isRecord(argument) || argument.isRepeated || typeof argument.value !== 'string' ||
      /[<>{}]/.test(argument.value) || hasVariables(argument.variables)) return undefined;
    if (argument.type === 'positional') result.push(argument.value);
    else if (argument.type === 'named' && typeof argument.name === 'string' && argument.name.trim()) result.push(`${argument.name.trim()}=${argument.value}`);
    else return undefined;
  }
  return result;
}
function packageOption(value: unknown, serverName: string, fallbackVersion: string): McpMarketplaceInstallOption | undefined {
  if (!isRecord(value) || !isRecord(value.transport) || value.transport.type !== 'stdio' ||
    typeof value.registryType !== 'string' || typeof value.identifier !== 'string') return undefined;
  const registry = value.registryType.trim().toLowerCase();
  const identifier = value.identifier.trim();
  const version = typeof value.version === 'string' && value.version.trim() ? value.version.trim() : fallbackVersion;
  const command = ({ npm: 'npx', pypi: 'uvx', oci: 'docker', nuget: 'dnx' } as Record<string, string>)[registry];
  if (!identifier || !command || (value.runtimeHint && String(value.runtimeHint).trim().toLowerCase() !== command)) return undefined;
  const specifier = registry === 'oci'
    ? (identifier.split('/').pop()?.includes(':') || identifier.includes('@sha256:') ? identifier : version ? `${identifier}:${version}` : '')
    : version ? registry === 'pypi' ? `${identifier}==${version}` : `${identifier}@${version}` : '';
  const runtimeArgs = argumentsList(value.runtimeArguments);
  const packageArgs = argumentsList(value.packageArguments);
  if (!specifier || !runtimeArgs || !packageArgs || (value.environmentVariables !== undefined && !Array.isArray(value.environmentVariables))) return undefined;
  const environment: Record<string, string> = {};
  const required: string[] = [];
  for (const variable of (value.environmentVariables ?? []) as unknown[]) {
    if (!isRecord(variable) || typeof variable.name !== 'string' || !variable.name.trim()) return undefined;
    const name = variable.name.trim();
    // 密钥型变量一律只公布名称，不能把采集环境或模板秘密值公开。
    const secret = variable.isSecret === true || /key|token|secret|password|authorization/i.test(name);
    const staticValue = !secret && typeof variable.value === 'string' && !/[<>{}]/.test(variable.value)
      ? variable.value : !secret && typeof variable.default === 'string' && !/[<>{}]/.test(variable.default) ? variable.default : '';
    environment[name] = staticValue;
    if (!staticValue) required.push(name);
  }
  // OCI 保留已有 run 与 Docker 全局参数；按名称透传环境，密钥仍只保存在进程环境中。
  const runIndex = runtimeArgs.indexOf('run');
  const ociRuntimeArgs = runIndex < 0
    ? ['run', '-i', '--rm', ...runtimeArgs]
    : [...runtimeArgs.slice(0, runIndex + 1), '-i', '--rm', ...runtimeArgs.slice(runIndex + 1)];
  const args = registry === 'oci'
    ? [...ociRuntimeArgs, ...Object.keys(environment).flatMap((name) => ['-e', name]), specifier, ...packageArgs]
    : [...runtimeArgs, specifier, ...packageArgs];
  const config = parseMcpConfig({ type: 'stdio', command, args, env: environment });
  return config ? { serverName, config, requiredEnvironmentVariables: [...new Set(required)], requiresConfiguration: required.length > 0 } : undefined;
}

export function parseRegistryEntry(source: MarketplaceSource, value: unknown): McpMarketplaceEntry | null {
  if (!isRecord(value) || !isRecord(value.server)) return null;
  const server = value.server;
  const name = typeof server.name === 'string' ? server.name.trim() : '';
  const title = typeof server.title === 'string' ? server.title.trim() : '';
  const description = typeof server.description === 'string' ? server.description.trim() : '';
  const version = typeof server.version === 'string' ? server.version.trim() : '';
  const meta = isRecord(value._meta) ? value._meta['io.modelcontextprotocol.registry/official'] : undefined;
  if (!name || !description || !isRecord(meta) || meta.status !== 'active') return null;
  const serverName = title || name;
  const options = [
    ...(Array.isArray(server.remotes) ? server.remotes : []).map((remote) => remoteOption(remote, serverName)),
    ...(Array.isArray(server.packages) ? server.packages : []).map((item) => packageOption(item, serverName, version)),
  ].filter((option): option is McpMarketplaceInstallOption => Boolean(option));
  const installOptions = [...new Map(options.map((option) => [option.config.type, option])).values()];
  if (!installOptions.length) return null;
  const transports = normalizeMcpTransports(installOptions.map((option) => option.config.type));
  const repository = parseGitHubRepositoryUrl(isRecord(server.repository) ? server.repository.url : undefined);
  return {
    id: `${source.id}:${name.toLowerCase()}`, sourceId: source.id, sourceName: source.name, trustLevel: source.trustLevel,
    kind: 'mcp', name: title || name, description, publisher: name.split('/')[0] || name, version: version || undefined,
    repository: repository ? { owner: repository.owner, name: repository.repository, url: repository.url } : undefined,
    popularity: 0, popularityMetric: 'unknown', tags: transports,
    updatedAt: typeof meta.updatedAt === 'string' ? meta.updatedAt : undefined,
    transport: transports[0], transports, installOptions,
  };
}
export function mergeMcpMarketplaceEntries(entries: McpMarketplaceEntry[]): McpMarketplaceEntry[] {
  const result = new Map<string, McpMarketplaceEntry>();
  for (const entry of entries) {
    const previous = result.get(entry.id);
    const options = [...new Map([...(previous?.installOptions ?? []), ...entry.installOptions].map((option) => [option.config.type, option])).values()];
    const transports = normalizeMcpTransports(options.map((option) => option.config.type));
    result.set(entry.id, previous ? { ...previous, tags: [...new Set([...previous.tags, ...entry.tags, ...transports])],
      transport: transports[0], transports, installOptions: options } : entry);
  }
  return [...result.values()];
}
