/**
 * @file Global Jest setup that runs once before the test suite starts.
 */

/**
 * Prepares the shared test environment before any test file runs. The suite
 * needs no external services, so there is nothing to start.
 * @returns A promise that resolves once setup is complete.
 * @example
 * ```ts
 * await setup();
 * ```
 */
export default async function setup(): Promise<void> {
  // No external services are required for the test suite.
}
