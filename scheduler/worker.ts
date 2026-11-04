interface Env {
  readonly CATALOG_DEPLOY_HOOK_URL?: string;
}

const HOOK_TIMEOUT_MS = 15_000;
const HOOK_RESPONSE_BYTES = 16 * 1024;

function deployHookUrl(value: string | undefined): URL {
  if (!value?.trim() || value.length > 2048) throw new Error('缺少有效的市场 Deploy Hook Secret');
  const url = new URL(value.trim());
  // Hook URL 本身是凭据，只允许 Cloudflare 的专用入口，禁止重定向或附加参数。
  // The hook URL is a credential; allow only Cloudflare's dedicated endpoint.
  if (url.protocol !== 'https:' || url.hostname !== 'api.cloudflare.com' ||
    url.username || url.password || url.search || url.hash || (url.port && url.port !== '443') ||
    !/^\/client\/v4\/pages\/webhooks\/deploy_hooks\/[a-zA-Z\d_-]+$/.test(url.pathname)) {
    throw new Error('市场 Deploy Hook 目标不合法');
  }
  return url;
}

async function consumeHookResponse(response: Response): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      bytes += chunk.value.byteLength;
      if (bytes > HOOK_RESPONSE_BYTES) throw new Error('市场 Deploy Hook 响应超过允许大小');
    }
  } catch (error) {
    try { await reader.cancel(); }
    catch { console.warn('市场 Deploy Hook 响应流取消失败'); }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    let stage = '校验调度配置';
    let status: number | undefined;
    let signal: AbortSignal | undefined;
    try {
      const target = deployHookUrl(env.CATALOG_DEPLOY_HOOK_URL);
      signal = AbortSignal.timeout(HOOK_TIMEOUT_MS);
      stage = '发送构建触发请求';
      // 每次调度只有一次 POST；不重试、不采集、不轮询部署，也不导入 Node 依赖。
      // One POST per invocation: no retries, collection, deployment polling, or Node imports.
      const response = await fetch(target, {
        method: 'POST', redirect: 'error', signal,
      });
      status = response.status;
      stage = '校验构建触发响应';
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('市场 Deploy Hook 未接受请求');
      }
      await consumeHookResponse(response);
      console.info('市场 Deploy Hook 已接受；不代表构建或发布成功，请查看市场 Pages 部署记录', {
        计划时间: new Date(controller.scheduledTime).toISOString(), HTTP状态: status,
      });
    } catch {
      // 不记录原始异常、URL 或响应正文，避免网络错误携带 Secret。
      // Never log raw errors, URLs, or response bodies, which may expose the secret.
      console.error('市场构建触发未确认；本次不自动重试，请核对市场 Pages 部署记录', {
        阶段: stage, HTTP状态: status, 已超时: signal?.aborted ?? false,
      });
      throw new Error('市场构建触发失败或结果未知；生产发布状态须单独确认');
    }
  },
} satisfies ExportedHandler<Env>;
