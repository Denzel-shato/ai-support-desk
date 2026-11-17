/**
 * Retries a small, idempotent write a couple of times. Only for writes that
 * are safe to repeat (the outcome record only applies while the claim is still
 * "sending"). Never use it around the webhook call itself.
 */
export async function retryShort<T>(
  fn: () => Promise<T>,
  delaysMs: readonly number[] = [250, 750],
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i <= delaysMs.length; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < delaysMs.length) await new Promise((r) => setTimeout(r, delaysMs[i]));
    }
  }
  throw lastError;
}
