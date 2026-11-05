import type { MarketplaceEntry, MarketplaceSortOrder } from './types.ts';

type OrderEntry = Pick<MarketplaceEntry, 'id' | 'name' | 'repository' | 'popularity' | 'popularityMetric'>;

// 静态构建、自定义来源和客户端搜索共用排序语义，不把安装量或未知 Star 当成零。
export function compareMarketplaceEntries(
  left: OrderEntry, right: OrderEntry, order: MarketplaceSortOrder, installedIds?: Set<string>,
): number {
  const installedDifference = installedIds
    ? Number(installedIds.has(right.id)) - Number(installedIds.has(left.id)) : 0;
  if (installedDifference) return installedDifference;
  const nameDifference = left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
  if (order === 'name-asc' || order === 'name-desc') return order === 'name-asc' ? nameDifference : -nameDifference;
  const leftStars = getMarketplaceStars(left);
  const rightStars = getMarketplaceStars(right);
  if (leftStars === undefined || rightStars === undefined) {
    return leftStars === undefined && rightStars === undefined
      ? nameDifference : leftStars === undefined ? 1 : -1;
  }
  return (leftStars - rightStars) * (order === 'popular-desc' ? -1 : 1) || nameDifference;
}
export function getMarketplaceStars(entry: OrderEntry): number | undefined {
  if (Number.isFinite(entry.repository?.stars)) return Math.max(0, entry.repository?.stars ?? 0);
  return (entry.popularityMetric === 'stars' ||
    (entry.popularityMetric === undefined && entry.popularity > 0)) && Number.isFinite(entry.popularity)
    ? Math.max(0, entry.popularity) : undefined;
}
export function formatStars(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
