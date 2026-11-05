// 独立市场核心快照：与主站同名模块同步规则，仅引用仓库内源码。
import type { ParsedSkillDefinition, SkillSource } from './types.ts';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { SKILL_MARKDOWN_MAX_CHARS } from './package-policy.ts';

export const MAX_SKILL_IMPORT_CHARS = SKILL_MARKDOWN_MAX_CHARS;

const DEFAULT_SKILL_NAME = 'Untitled Skill';
const DESCRIPTION_MAX_CHARS = 180;
const MAX_SKILL_KEYWORDS = 32;
const MAX_SKILL_KEYWORD_CHARS = 64;

const MAX_METADATA_DEPTH = 8;
const MAX_METADATA_NODES = 2_000;

function normalizeMetadataValue(value: unknown, context: z.RefinementCtx): string {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;

  // 扩展元数据仅作为有界 JSON 数据保存，不解释其中的安装、环境变量或授权声明。
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;

    const item = current.value;
    const scalar = item === null || typeof item === 'string' || typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item));
    const structured = typeof item === 'object' && item !== null &&
      (Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null);

    if (nodes > MAX_METADATA_NODES || current.depth > MAX_METADATA_DEPTH || (!scalar && !structured)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: '技能扩展元数据结构不支持或超过限制' });
      return z.NEVER;
    }

    if (structured) {
      const children = Object.values(item as Record<string, unknown>);

      if (nodes + pending.length + children.length > MAX_METADATA_NODES) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: '技能扩展元数据节点超过限制' });
        return z.NEVER;
      }

      pending.push(...children.map((child) => ({ value: child, depth: current.depth + 1 })));
    }
  }

  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

const skillFrontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  // 保持字符串映射输出，结构化扩展以 JSON 字符串无损保留，原始 Markdown 不改写。
  metadata: z.record(z.union([
    z.string(), z.number().finite(), z.boolean(), z.record(z.unknown()), z.array(z.unknown()),
  ]).transform(normalizeMetadataValue)).optional(),
  'allowed-tools': z.union([z.string(), z.array(z.string())])
    .transform((value) => Array.isArray(value) ? value.join(' ') : value).optional(),
  when_to_use: z.string().optional(),
  keywords: z.union([z.string(), z.array(z.string())]).optional(),
}).passthrough();

type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function parseFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);

  if (!match) {
    return {};
  }

  // 使用受限 YAML 解析，支持折叠文本，不将嵌套 metadata 错读成顶层名称。
  const document = parseDocument(match[1], { uniqueKeys: true, customTags: [] });

  if (document.errors.length) {
    throw new Error('skillPackageYamlInvalid');
  }

  if (document.warnings.length) {
    // 未知标签等 YAML 扩展通常以 warning 报告；技能包边界不允许静默接受。
    throw new Error('skillPackageYamlUnsafe');
  }

  let value: unknown;

  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    // YAML 别名在技能边界禁用，避免别名展开造成不确定的内存消耗。
    throw new Error('skillPackageYamlUnsafe');
  }

  const parsed = skillFrontmatterSchema.safeParse(value ?? {});

  if (!parsed.success) {
    throw new Error('skillPackageMetadataFieldsInvalid');
  }

  return parsed.data;
}

function removeFrontmatter(content: string): string {
  return content.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, '').trim();
}

function extractHeading(content: string): string | undefined {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || undefined;
}

function normalizeWhitespace(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function truncateDescription(content: string): string {
  // 省略号计入上限，截断后长度不超过 DESCRIPTION_MAX_CHARS。
  return content.length > DESCRIPTION_MAX_CHARS ? `${content.slice(0, DESCRIPTION_MAX_CHARS - 3)}...` : content;
}

function extractDescription(content: string): string {
  const body = removeFrontmatter(content);
  const paragraphs = body.split(/\n{2,}/);
  const paragraph = paragraphs.find((item) => {
    const trimmed = item.trim();

    return Boolean(trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('```'));
  });

  return paragraph ? truncateDescription(normalizeWhitespace(paragraph)) : '';
}

/*
 * 字符串关键词支持逗号或分号分隔；YAML 数组按元素处理，保留元素内部的逗号。
 * 统一限制长度、去重并保留原始大小写用于展示。
 */
function parseKeywords(value: string | string[] | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const values = Array.isArray(value) ? value : value.split(/[,;，；]/);

  const keywords = Array.from(
    new Set(
      values
        .map((keyword) => stripWrappingQuotes(keyword))
        // 在导入边界限制匹配成本，避免单行 frontmatter 生成无界关键词集合。
        .map((keyword) => keyword.slice(0, MAX_SKILL_KEYWORD_CHARS).trim())
        .filter(Boolean),
    ),
  ).slice(0, MAX_SKILL_KEYWORDS);

  return keywords.length > 0 ? keywords : undefined;
}

export function parseSkillMarkdown(markdown: string, source: SkillSource = 'manual'): ParsedSkillDefinition {
  const content = normalizeLineEndings(markdown).trim();

  if (!content) {
    throw new Error('Skill content is required');
  }

  if (content.length > MAX_SKILL_IMPORT_CHARS) {
    throw new Error('Skill content is too large');
  }

  const metadata = parseFrontmatter(content);

  if (source === 'market' && !metadata.name?.trim()) {
    throw new Error('skillPackageNameRequired');
  }

  if (source === 'market' && !metadata.description?.trim()) {
    throw new Error('skillPackageDescriptionRequired');
  }

  const name = metadata.name || extractHeading(content) || DEFAULT_SKILL_NAME;
  const description = metadata.description || extractDescription(content);

  // when_to_use 与 description 同样只进清单，因此复用同一截断上限。
  const whenToUse = metadata.when_to_use ? truncateDescription(normalizeWhitespace(metadata.when_to_use)) : '';
  const keywords = parseKeywords(metadata.keywords);
  const license = metadata.license?.trim();
  const compatibility = metadata.compatibility?.trim();
  const allowedTools = metadata['allowed-tools']?.trim();

  return {
    name: name.trim() || DEFAULT_SKILL_NAME,
    description: description.trim(),
    ...(license ? { license } : {}),
    ...(compatibility ? { compatibility } : {}),
    ...(metadata.metadata ? { metadata: { ...metadata.metadata } } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(whenToUse ? { whenToUse } : {}),
    ...(keywords ? { keywords } : {}),
    content,
    source,
  };
}
