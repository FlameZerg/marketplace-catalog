// 独立市场核心快照：与主站同名模块同步规则，仅引用仓库内源码。
import type { MarketplaceSource } from './types.ts';
import { MODELSCOPE_MCP_CATALOG_URL } from '../common/modelscope-mcp.ts';

// 来源身份由客户端和离线采集器共同维护，不读取用户的私有来源配置。
const skillSource = (
  id: string, name: string, owner: string, repository: string, ref = 'main',
  discovery: Pick<MarketplaceSource, 'skillDiscovery' | 'skillManifestPath' | 'skillDirectories'> = { skillDiscovery: 'publisher-manifest' },
): MarketplaceSource => ({
  id, name, owner, repository, ref, kind: 'skill', type: 'github-skills', enabled: true,
  builtIn: true, trustLevel: 'official-publisher', ...discovery,
});
export const BUILTIN_MARKETPLACE_SOURCES: MarketplaceSource[] = [
  skillSource('skills-anthropic', 'Anthropic Skills', 'anthropics', 'skills'),
  skillSource('skills-cloudflare', 'Cloudflare Skills', 'cloudflare', 'skills'),
  skillSource('skills-stripe', 'Stripe Skills', 'stripe', 'ai'),
  skillSource('skills-expo', 'Expo Skills', 'expo', 'skills'),
  skillSource('skills-huggingface', 'Hugging Face Skills', 'huggingface', 'skills', 'main',
    { skillDiscovery: 'publisher-manifest', skillManifestPath: '.claude-plugin/marketplace-internal.json' }),
  skillSource('skills-supabase', 'Supabase Skills', 'supabase', 'agent-skills'),
  skillSource('skills-microsoft', 'Microsoft Skills', 'microsoft', 'skills', 'e816c333d6367ab4aca761f4dee801d5c3b89072'),
  skillSource('skills-sentry', 'Sentry Skills', 'getsentry', 'skills', 'c2f99a5b04b4cd992ec3022d7c2c3e23e938d241'),
  skillSource('skills-sanity', 'Sanity Skills', 'sanity-io', 'agent-toolkit', '0b3376799826fc82937770605d671b612bfc2d4f'),
  skillSource('skills-resend', 'Resend Skills', 'resend', 'resend-skills', '8938c2a6f17903f9168c31431c842c68a68b19f3'),
  skillSource('skills-neon', 'Neon Skills', 'neondatabase', 'agent-skills', '2e0da3a1653bcdd227565ac14bb3e9e453a8b854'),
  skillSource('skills-vercel', 'Vercel Skills', 'vercel-labs', 'agent-skills', '063bee94c3f4df8453406c830b0a7df0f2860278',
    { skillDiscovery: 'publisher-directories', skillDirectories: ['skills'] }),
  skillSource('skills-remotion', 'Remotion Skills', 'remotion-dev', 'skills', 'bd566b65d521b40fe92e1f26766e82de9e291693',
    { skillDiscovery: 'publisher-directories', skillDirectories: ['skills'] }),
  {
    id: 'mcp-official-registry', kind: 'mcp', type: 'mcp-registry', name: 'MCP Registry',
    url: 'https://registry.modelcontextprotocol.io/v0.1/servers', enabled: true, builtIn: true,
    trustLevel: 'registry-namespace-verified',
  },
  {
    id: 'mcp-modelscope', kind: 'mcp', type: 'modelscope-mcp', name: 'ModelScope MCP',
    url: MODELSCOPE_MCP_CATALOG_URL, enabled: true, builtIn: true, trustLevel: 'platform-listed',
  },
];
export function getBuiltinMarketplaceSource(id: string): MarketplaceSource | undefined {
  return BUILTIN_MARKETPLACE_SOURCES.find((source) => source.id === id);
}
