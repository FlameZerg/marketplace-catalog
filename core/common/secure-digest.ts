// 独立市场核心快照：与主站同名模块同步规则，仅引用仓库内源码。
/**
 * SHA-256 摘要的统一入口（快速失败版本）。
 *
 * 与 `sha256.ts` 中返回 undefined 的宽松版本不同：本模块在 `crypto.subtle`
 * 不可用时直接抛出可读错误，用于「摘要缺失即不可继续」的关键路径
 * （缓存键、去重指纹、完整性校验），避免把"算不出"静默降级成"内容可能相同"。
 *
 * `crypto.subtle` 仅在安全上下文可用：HTTPS、本机回环，或桌面/移动端原生 WebView。
 * 局域网明文 HTTP 下不可用，此时抛错提示用户改用安全上下文。
 */

const SECURE_CONTEXT_ERROR =
  '当前环境不支持 SHA-256：需要安全上下文（HTTPS 或本机回环）。' +
  ' / SHA-256 is unavailable: a secure context (HTTPS or loopback) is required.';

/** 获取可用的 SubtleCrypto，不可用时抛出统一的可读错误。 */
export function requireSubtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;

  if (!subtle) {
    throw new Error(SECURE_CONTEXT_ERROR);
  }

  return subtle;
}

/** 计算 SHA-256 原始字节；环境不支持时抛错。 */
export async function sha256Bytes(data: BufferSource): Promise<Uint8Array> {
  const digest = await requireSubtleCrypto().digest('SHA-256', data);

  return new Uint8Array(digest);
}

/** 小写十六进制摘要；环境不支持时抛错。 */
export async function sha256HexStrict(data: BufferSource): Promise<string> {
  const bytes = await sha256Bytes(data);

  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}
