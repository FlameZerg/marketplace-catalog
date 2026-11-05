// 独立市场核心快照：与主站同名模块同步规则，仅引用仓库内源码。
import { mcpServerConfigSchema } from '../common/mcp-config-schema.ts';
import type { MCPServerConfig } from '../common/mcp-config-schema.ts';
import { assertAllowedRemoteUrl, assertGitHubCoordinate } from './catalog-files.client.ts';

function ipv4NumberToAddress(value: number): string {
  return [
    Math.floor(value / 0x1000000) % 0x100,
    Math.floor(value / 0x10000) % 0x100,
    Math.floor(value / 0x100) % 0x100,
    value % 0x100,
  ].join('.');
}

function normalizeIpv4Address(hostname: string): string | undefined {
  const parts = hostname.split('.');

  if (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  ) {
    return parts.map(Number).join('.');
  }

  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(hostname)) {
    return undefined;
  }

  const value = Number(hostname);

  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
    ? ipv4NumberToAddress(value)
    : undefined;
}

function normalizeRemoteHostname(value: string): string {
  // 在私网判断前统一等价主机写法，避免尾点、整数 IP 与 IPv4-mapped IPv6 绕过校验。
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const mappedIpv4 = hostname.match(/^(?:::ffff|0:0:0:0:0:ffff):(.+)$/)?.[1];

  if (mappedIpv4) {
    const dottedAddress = normalizeIpv4Address(mappedIpv4);

    if (dottedAddress) {
      return dottedAddress;
    }

    const hexadecimalParts = mappedIpv4.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);

    if (hexadecimalParts) {
      return ipv4NumberToAddress(
        Number.parseInt(hexadecimalParts[1], 16) * 0x10000 +
          Number.parseInt(hexadecimalParts[2], 16),
      );
    }
  }

  return normalizeIpv4Address(hostname) ?? hostname;
}

// 多个 MCP 目录共用现有公开地址校验，平台适配器不得绕过连接安全边界。
export function assertPublicMcpRemoteUrl(value: string): URL {
  const url = assertAllowedRemoteUrl(value);
  const hostname = normalizeRemoteHostname(url.hostname);
  const isPrivateIpv4 =
    /^(?:0|10|127)\./.test(hostname) ||
    /^169\.254\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname);
  const isPrivateIpv6 =
    hostname.includes(':') &&
    (hostname === '::1' ||
      hostname.startsWith('fc') ||
      hostname.startsWith('fd') ||
      /^fe[89ab]/.test(hostname));

  if (hostname === 'localhost' || isPrivateIpv4 || isPrivateIpv6) {
    throw new Error('Marketplace MCP URL must use a public host');
  }

  return url;
}

export function parseGitHubRepositoryUrl(value: unknown): { owner: string; repository: string; url: string } | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  try {
    const url = new URL(value);

    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
      return undefined;
    }

    const [owner, repositoryWithSuffix] = url.pathname.split('/').filter(Boolean);
    const repository = repositoryWithSuffix?.replace(/\.git$/i, '');

    if (!owner || !repository) {
      return undefined;
    }

    return {
      owner: assertGitHubCoordinate(owner, 'owner'),
      repository: assertGitHubCoordinate(repository, 'repository'),
      url: `https://github.com/${owner}/${repository}`,
    };
  } catch {
    return undefined;
  }
}

export function parseMcpConfig(value: unknown): MCPServerConfig | undefined {
  const parsed = mcpServerConfigSchema.safeParse(value);

  return parsed.success ? parsed.data : undefined;
}

// 只归一化来源明确声明的协议，不根据服务名称或地址猜测。
export function normalizeMcpTransports(values: unknown[]): MCPServerConfig['type'][] {
  const transports = values.map((value) => {
    if (value === 'stdio' || value === 'sse') {
      return value;
    }

    return value === 'streamable-http' || value === 'streamable_http' || value === 'streamablehttp'
      ? 'streamable-http' as const
      : undefined;
  });

  return [...new Set(transports.filter((value): value is MCPServerConfig['type'] => value !== undefined))];
}
