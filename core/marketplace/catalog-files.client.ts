// 独立市场核心快照：与主站同名模块同步规则，仅引用仓库内源码。
import { MarketplaceRequestError, classifyMarketplaceStatus, getMarketplaceRetryAt } from '../common/marketplace-request.ts';
import { SKILL_PACKAGE_MAX_FILES, SKILL_FILE_MAX_BYTES, SKILL_PACKAGE_MAX_BYTES } from '../skills/package-policy.ts';
import { sha256Bytes } from '../common/secure-digest.ts';

// 保留既有导出路径，离线采集直接复用无浏览器依赖的市场域实现。
export { mapWithConcurrency } from './concurrency.ts';

// 市场内部复用文件读取和完整性校验，文件读取的超时覆盖整个响应体。
const REQUEST_TIMEOUT_MS = 20_000;
const JSDELIVR_CDN_BASE = 'https://cdn.jsdelivr.net/gh';

export const MAX_MARKET_FILES_PER_SKILL = SKILL_PACKAGE_MAX_FILES;
export const MAX_MARKET_TEXT_CHARS = SKILL_FILE_MAX_BYTES;
export const MAX_MARKET_TOTAL_CHARS = SKILL_PACKAGE_MAX_BYTES;

const SUPPORTED_TEXT_EXTENSIONS = new Set([
  '.css', '.csv', '.env', '.html', '.js', '.json', '.jsx', '.md', '.markdown', '.mjs',
  '.py', '.sh', '.sql', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml',
]);
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.py', '.sh', '.ts']);

export interface GitHubRepositoryFile {
  path: string;
  size?: number;
  hash?: string;
}

export function assertAllowedRemoteUrl(value: string): URL {
  const url = new URL(value);
  const isLocalDevelopment =
    url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');

  if (url.protocol !== 'https:' && !isLocalDevelopment) {
    throw new Error('Marketplace sources must use HTTPS');
  }

  if (url.username || url.password) {
    throw new Error('Marketplace source URL must not contain credentials');
  }

  return url;
}

export function assertGitHubCoordinate(value: string, field: string): string {
  const normalized = value.trim();
  const pattern =
    field === 'owner'
      ? /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
      : /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

  if (!pattern.test(normalized)) {
    throw new Error(`Invalid GitHub ${field}`);
  }

  return normalized;
}

export function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').trim();

  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) {
    throw new Error('Marketplace entry contains an unsafe path');
  }

  const segments = normalized.split('/').filter(Boolean);

  if (segments.some((segment) => segment === '..')) {
    throw new Error('Marketplace entry contains an unsafe path');
  }

  return segments.join('/');
}

export function getFileName(path: string): string {
  return normalizePath(path).split('/').pop() || '';
}

function getExtension(path: string): string {
  const fileName = getFileName(path).toLowerCase();
  const extensionIndex = fileName.lastIndexOf('.');

  return extensionIndex >= 0 ? fileName.slice(extensionIndex) : '';
}

export function isSupportedTextPath(path: string): boolean {
  return getFileName(path).toLowerCase() === 'skill.md' || SUPPORTED_TEXT_EXTENSIONS.has(getExtension(path));
}

export function isScriptPath(path: string): boolean {
  return SCRIPT_EXTENSIONS.has(getExtension(path));
}

const MARKETPLACE_JSON_MAX_BYTES = 8 * 1024 * 1024;

export function buildJsDelivrFileUrl(owner: string, repository: string, revision: string, path: string): string {
  const encodedPath = normalizePath(path).split('/').map(encodeURIComponent).join('/');

  return `${JSDELIVR_CDN_BASE}/${assertGitHubCoordinate(owner, 'owner')}/${assertGitHubCoordinate(
    repository,
    'repository',
  )}@${encodeURIComponent(revision)}/${encodedPath}`;
}

export async function fetchMarketplaceBytes(
  url: string,
  signal?: AbortSignal,
  options?: { request?: (signal: AbortSignal) => Promise<Response>; maxBytes?: number },
): Promise<Uint8Array<ArrayBuffer>> {
  if (!url.startsWith('/api/skills-directory?')) {assertAllowedRemoteUrl(url);}

  const controller = new AbortController();
  let timedOut = false;
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });

  if (signal?.aborted) {controller.abort();}

  try {
    const response = options?.request
      ? await options.request(controller.signal)
      : await fetch(url, { signal: controller.signal, redirect: 'error' });

    if (response.ok && !response.body) {
      throw new Error('marketDirectoryStreamAborted');
    }

    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);

      const local = url.startsWith('/api/skills-directory?');
      const upstreamStatus = local ? Number(response.headers.get('X-Marketplace-Upstream-Status')) : 0;
      const status = upstreamStatus >= 400 && upstreamStatus <= 599 ? upstreamStatus : response.status;
      const code = local && response.status === 403
        ? 'marketDirectoryRequestRejected' : classifyMarketplaceStatus(status, response.headers);
      throw new MarketplaceRequestError(code, status, getMarketplaceRetryAt(response.headers),
        local ? (upstreamStatus ? 'github.com' : 'application') : new URL(url).hostname);
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;

    try {
      while (true) {
        const chunk = await reader.read();

        if (chunk.done) {break;}

        size += chunk.value.byteLength;

        if (size > (options?.maxBytes ?? SKILL_FILE_MAX_BYTES)) {throw new Error('skillPackageTooLarge');}

        chunks.push(chunk.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(size);
    let offset = 0;

    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }

    return bytes;
  } catch (error) {
    if (error instanceof MarketplaceRequestError) {
      throw error;
    }

    if (
      error instanceof Error &&
      (error.message === 'skillPackageTooLarge' ||
        error.message === 'marketDirectoryRateLimited' ||
        error.message === 'marketDirectoryUnavailable' ||
        error.message === 'marketDirectoryHttpError' ||
        error.message === 'marketDirectoryStreamAborted')
    ) {
      throw error;
    }

    if (timedOut) {
      throw new Error('marketDirectoryTimeout');
    }

    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      throw new Error('marketDirectoryRequestAborted');
    }

    const message = error instanceof Error ? error.message.toLowerCase() : '';

    if (message.includes('bodystreambuffer') || (message.includes('stream') && message.includes('abort'))) {
      throw new Error('marketDirectoryStreamAborted');
    }

    if (error instanceof TypeError) {
      // Fetch 对 DNS、TLS 和离线等连接错误统一抛出 TypeError，浏览器不会暴露更细的网络原因。
      throw new Error('marketDirectoryNetworkError');
    }

    throw new Error('marketDirectoryUnavailable');
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function fetchJson(url: string): Promise<unknown> {
  return JSON.parse(
    new TextDecoder().decode(
      await fetchMarketplaceBytes(url, undefined, { maxBytes: MARKETPLACE_JSON_MAX_BYTES }),
    ),
  );
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';

  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }

  return btoa(binary);
}

export async function fetchTextWithDigest(
  url: string,
  expectedHash?: string,
): Promise<{ content: string; hash?: string }> {
  const bytes = await fetchMarketplaceBytes(url);

  // 无完整性校验要求时按可选摘要处理；一旦提供 expectedHash 即走强制校验，
  // 摘要不可用会由下方 !hash 分支快速失败。摘要计算统一走 secure-digest。
  let hash: string | undefined;

  if (globalThis.crypto?.subtle) {
    hash = encodeBase64(await sha256Bytes(bytes));
  }

  if (expectedHash && hash !== expectedHash) {
    throw new Error('Marketplace file integrity verification failed');
  }

  if (expectedHash && !hash) {
    throw new Error('Browser cryptographic verification is unavailable');
  }

  return { content: new TextDecoder().decode(bytes), hash };
}

export async function fetchMarketplaceBlob(url: string, expectedHash?: string, gitBlobHash?: string): Promise<{ blob: Blob; hash: string }> {
  const bytes = await fetchMarketplaceBytes(url);

  if (!crypto.subtle) {throw new Error('skillPackageCryptoUnavailable');}

  const buffer = bytes.slice().buffer as ArrayBuffer;
  const hash = encodeBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)));

  if (expectedHash && expectedHash !== hash) {throw new Error('skillPackageIntegrityFailed');}

  if (gitBlobHash) {
    const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
    const object = new Uint8Array(header.length + bytes.length);
    object.set(header);
    object.set(bytes, header.length);

    const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', object)))
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');

    if (actual !== gitBlobHash) {throw new Error('skillPackageIntegrityFailed');}
  }

  return { blob: new Blob([buffer]), hash };
}

export async function computeMarketplaceDigest(value: string): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle) {
    return undefined;
  }

  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));

  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function hasMissingRelativeMarkdownReference(markdown: string, availablePaths: Set<string>): boolean {
  const referencePattern = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*)?\s*\)/g;

  for (const match of markdown.matchAll(referencePattern)) {
    const rawTarget = match[1]?.trim();

    if (!rawTarget || rawTarget.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(rawTarget) || rawTarget.startsWith('//')) {
      continue;
    }

    try {
      const decodedTarget = decodeURIComponent(rawTarget).split(/[?#]/, 1)[0]?.replace(/^(?:\.\/)+/, '');

      if (!decodedTarget) {
        continue;
      }

      const target = normalizePath(decodedTarget);
      const targetPrefix = `${target.replace(/\/+$/, '')}/`;

      if (!availablePaths.has(target) && !Array.from(availablePaths).some((path) => path.startsWith(targetPrefix))) {
        return true;
      }
    } catch {
      return true;
    }
  }

  return false;
}
