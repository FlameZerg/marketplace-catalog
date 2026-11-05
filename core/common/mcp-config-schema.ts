// 独立市场核心快照：与主站同名模块同步规则，仅引用仓库内源码。
import { z } from 'zod';

// 纯配置契约不导入 AI 客户端、React 或运行时 store，供离线公共目录解析复用。
export const stdioServerConfigSchema = z.object({
  type: z.literal('stdio').optional(), command: z.string().min(1),
  args: z.array(z.string()).optional(), cwd: z.string().optional(), env: z.record(z.string()).optional(),
}).transform((data) => ({ ...data, type: 'stdio' as const }));
export const sseServerConfigSchema = z.object({
  type: z.literal('sse').optional(), url: z.string().url(), headers: z.record(z.string()).optional(),
}).transform((data) => ({ ...data, type: 'sse' as const }));
export const streamableHTTPServerConfigSchema = z.object({
  type: z.literal('streamable-http').optional(), url: z.string().url(), headers: z.record(z.string()).optional(),
}).transform((data) => ({ ...data, type: 'streamable-http' as const }));
export const mcpServerConfigSchema = z.union([stdioServerConfigSchema, sseServerConfigSchema, streamableHTTPServerConfigSchema]);

// 配置类型由同一校验契约推导，离线核心不再通过主站 MCP 服务取得类型。
export type MCPServerConfig = z.infer<typeof mcpServerConfigSchema>;
