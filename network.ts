import { createHash } from 'node:crypto';
import type { CatalogRunContext } from './run-context';

// 网络读取只依赖计量与取消接口，可选统计可在同一链路增加非致命的独立预算。
export type CatalogNetworkContext = Pick<
  CatalogRunContext, 'check' | 'consumeRequest' | 'consumeBytes' | 'requestSignal'
>;

const JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
type CatalogQuery = { method: 'PUT'; body: string };

// 恢复与采集共享流式读取和字节计量，不能依赖 Content-Length 或分别计算预算。
export async function readResponseBytes(
  response: Response,
  context: CatalogNetworkContext,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!response.body) throw new Error('marketCollectorUnavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      context.check();
      const chunk = await reader.read();
      context.check();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      context.consumeBytes(chunk.value.byteLength);
      // 单响应超限由单包或来源隔离处理；全局预算仍由 consumeBytes 判定并中止批次。
      if (size > maxBytes) throw new Error('marketCollectorResponseTooLarge');
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    try { await reader.cancel(error); }
    catch { console.warn('采集响应流取消失败，保留原始读取错误'); }
    context.check();
    throw error;
  } finally { reader.releaseLock(); }
}

export async function fetchBytes(
  url: string,
  context: CatalogNetworkContext,
  maxBytes = JSON_RESPONSE_BYTES,
  query?: CatalogQuery,
): Promise<Uint8Array> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || ![
    'api.github.com', 'data.jsdelivr.com', 'cdn.jsdelivr.net', 'registry.modelcontextprotocol.io', 'modelscope.cn',
  ].includes(target.hostname) || target.username || target.password || target.hash ||
    (target.port && target.port !== '443')) throw new Error('marketCollectorTargetInvalid');
  if (query && (target.hostname !== 'modelscope.cn' || target.pathname !== '/api/v1/dolphin/mcpServers' ||
    query.body.length > 2000)) throw new Error('marketCollectorTargetInvalid');
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': 'marketplace-catalog',
    ...(query ? { 'content-type': 'application/json' } : {}),
    // 凭据仅发往 GitHub API，绝不转发到 CDN、生产目录或日志。
    ...(target.hostname === 'api.github.com' && process.env.GITHUB_TOKEN
      ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    context.consumeRequest();
    try {
      const response = await fetch(target, {
        headers, ...(query ?? {}), redirect: 'error', signal: context.requestSignal(),
      });
      context.check();
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        if (attempt === 0 && response.status >= 500) continue;
        throw new Error(`marketCollectorHttp${response.status}`);
      }
      return await readResponseBytes(response, context, maxBytes);
    } catch (error) {
      // 全批次超时必须保持致命预算错误，不能被来源保留或未知统计掩盖。
      context.check();
      throw error;
    }
  }
  throw new Error('marketCollectorUnavailable');
}

export async function fetchJson(url: string, context: CatalogNetworkContext, query?: CatalogQuery): Promise<unknown> {
  const bytes = await fetchBytes(url, context, JSON_RESPONSE_BYTES, query);
  context.check();
  const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
  context.check();
  return value;
}
export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
