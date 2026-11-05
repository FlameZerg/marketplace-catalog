// 独立市场核心快照：与主站同名模块同步规则，仅引用仓库内源码。
type TimeoutSignalCleanupOptions = {
  preserveAbortForwarding?: boolean;
};

// 统一转发调用方取消并管理超时，调用方仍自行决定错误类型与状态码映射。
export function createTimeoutSignal(
  callerSignal: AbortSignal | null | undefined,
  timeoutMs: number,
  timeoutReason?: unknown,
) {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
  let timeoutReached = false;
  let callerListenerAttached = false;

  const clearTimer = () => {
    if (timeoutId === undefined) {
      return;
    }

    globalThis.clearTimeout(timeoutId);
    timeoutId = undefined;
  };

  const abortFromCaller = () => {
    clearTimer();
    controller.abort(callerSignal?.reason);
  };

  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    if (callerSignal) {
      callerSignal.addEventListener('abort', abortFromCaller, { once: true });
      callerListenerAttached = true;
    }

    timeoutId = globalThis.setTimeout(() => {
      timeoutId = undefined;
      timeoutReached = true;

      if (timeoutReason === undefined) {
        controller.abort();
      } else {
        controller.abort(timeoutReason);
      }
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    cleanup: ({ preserveAbortForwarding = false }: TimeoutSignalCleanupOptions = {}) => {
      clearTimer();

      if (!preserveAbortForwarding && callerListenerAttached) {
        callerSignal?.removeEventListener('abort', abortFromCaller);
        callerListenerAttached = false;
      }
    },
    get didTimeout() {
      return timeoutReached;
    },
  };
}
