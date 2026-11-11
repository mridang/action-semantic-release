/**
 * @file Test helper that temporarily sets or unsets environment variables
 * around an asynchronous operation.
 */

/**
 * A higher-order function that wraps an asynchronous operation, setting
 * or unsetting temporary environment variables for its execution.
 *
 * It guarantees that the original environment is restored even if the
 * wrapped function fails. Pass a string value to set a variable, or
 * `null` to temporarily unset (delete) it.
 * @template T The resolved type of the wrapped asynchronous function.
 * @param env - An object where keys are variable names and values are the
 * string to set, or `null` to unset the variable.
 * @param fn - The asynchronous function to execute.
 * @returns A new async function that will run with the modified environment.
 * @example
 * ```ts
 * const readToken = withEnvVars({ GITHUB_TOKEN: 'fake-token' }, async () => {
 *   return process.env.GITHUB_TOKEN;
 * });
 * await readToken(); // 'fake-token', and the original value is restored after
 * ```
 */
export function withEnvVars<T>(
  env: Record<string, string | null>,
  fn: () => Promise<T>,
): () => Promise<T> {
  return async () => {
    const originalValues: Record<string, string | undefined> = {};

    for (const [key, newValue] of Object.entries(env)) {
      originalValues[key] = process.env[key];

      if (newValue === null) {
        delete process.env[key];
      } else {
        process.env[key] = newValue;
      }
    }

    try {
      return await fn();
    } finally {
      for (const [key, originalValue] of Object.entries(originalValues)) {
        if (originalValue === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalValue;
        }
      }
    }
  };
}
