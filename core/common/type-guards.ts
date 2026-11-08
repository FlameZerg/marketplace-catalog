// 独立市场核心快照：与主站同名模块同步规则，仅引用仓库内源码。
/** 统一判断未知值是否为非数组对象，领域字段校验仍由调用方负责。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
