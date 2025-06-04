export function withEnvVars<T>(
  env: Record<string, string>,
  fn: () => Promise<T>,
): () => Promise<T> {
  return async () => {
    const originalEnv = { ...process.env };
    Object.assign(process.env, env);
    try {
      return await fn();
    } finally {
      process.env = originalEnv;
    }
  };
}
