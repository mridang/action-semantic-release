/**
 * @file Global Jest teardown that runs once after the test suite finishes.
 */

/**
 * Releases the shared test environment after all test files have run. The suite
 * starts no external services, so there is nothing to stop.
 * @returns A promise that resolves once teardown is complete.
 * @example
 * ```ts
 * await teardown();
 * ```
 */
export default async function teardown(): Promise<void> {
  // No external services to tear down.
}
