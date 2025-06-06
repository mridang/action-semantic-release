/**
 * A higher-order function that wraps an asynchronous operation, setting
 * temporary environment variables for the duration of its execution.
 *
 * This is particularly useful in tests where you need to simulate
 * different environment conditions for a piece of code without affecting
 * other tests. It guarantees that the original environment is restored
 * even if the wrapped function fails.
 *
 * @param env An object of key-value pairs to set as temporary
 * environment variables.
 * @param fn The asynchronous function to execute within the temporary
 * environment.
 * @returns A new async function that, when called, will execute the
 * original function with the specified environment variables set.
 */
export function withEnvVars<T>(
  env: Record<string, string>,
  fn: () => Promise<T>,
): () => Promise<T> {
  return async () => {
    const originalValues: Record<string, string | undefined> = {};
    for (const key in env) {
      originalValues[key] = process.env[key];
      process.env[key] = env[key];
    }

    try {
      return await fn();
    } finally {
      for (const key in originalValues) {
        const originalValue = originalValues[key];
        if (originalValue === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalValue;
        }
      }
    }
  };
}
