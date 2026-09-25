import { RETRY_AFTER_429_MS } from './constants';

export function isRateLimited(err: unknown): boolean {
  return (err as { response?: { status?: number } } | undefined)?.response?.status === 429;
}

export const RATE_LIMITED = Symbol('rate-limited');

export const RATE_LIMIT_WARNING =
  'Vivino rate-limited this request twice (HTTP 429), so the result is partial. ' +
  'Wait a minute and call again with the returned cursor to continue.';

// One tool call's 429 budget (decision A3): the first 429 waits 60 s and
// retries; a second 429 anywhere in the same call gives up and returns
// RATE_LIMITED so the caller can hand back what it already has. The fetches
// passed in must use retry429: false, or the client would wait on its own too.
export function rateLimitGuard(): <T>(fn: () => Promise<T>) => Promise<T | typeof RATE_LIMITED> {
  let waited = false;
  return async fn => {
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (!isRateLimited(err)) throw err;
        if (waited) return RATE_LIMITED;
        waited = true;
        await new Promise(r => setTimeout(r, RETRY_AFTER_429_MS));
      }
    }
  };
}
