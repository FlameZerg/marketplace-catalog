import { stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
export async function resolve(specifier, context, nextResolve) {
  let candidate;
  if (specifier.startsWith('~/')) candidate = path.resolve(root, '../app', specifier.slice(2));
  else if (specifier.startsWith('.')) candidate = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
  else if (specifier === 'zod' || specifier === 'yaml') {
    return nextResolve(specifier, { ...context, parentURL: pathToFileURL(path.join(root, 'bootstrap.mjs')).href });
  }
  if (candidate) {
    for (const file of [candidate, `${candidate}.ts`, `${candidate}.js`, path.join(candidate, 'index.ts')]) {
      try {
        // 同名目录不是模块文件，应继续尝试扩展名及目录下的 index.ts。
        if ((await stat(file)).isFile()) return nextResolve(pathToFileURL(file).href, context);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  return nextResolve(specifier, context);
}
