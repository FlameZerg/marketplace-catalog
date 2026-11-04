import { register } from 'node:module';
// 原生 TS 去类型保持零构建；只为市场纯解析模块补齐扩展名和项目别名解析。
register('./resolver.mjs', import.meta.url);
