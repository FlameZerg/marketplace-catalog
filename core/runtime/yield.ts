import { setImmediate } from 'node:timers/promises';

// 离线核心显式让出 Node 事件循环，不依赖浏览器调度器或隐式兼容分支。
export async function yieldToMain(): Promise<void> {
  await setImmediate();
}
