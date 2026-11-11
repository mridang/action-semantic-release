/**
 * @file End-to-end tests that bundle the action with Rollup, run the bundle in
 * a VM context and exercise it against a local Git repository.
 */
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withTempDir } from './helpers/with-temp-dir.js';
import { withGitRepo } from './helpers/with-git-repo.js';
import { withEnvVars } from './helpers/with-env-vars.js';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { rollup } from 'rollup';
import { createRequire } from 'node:module';
import vm, { constants as VM } from 'node:vm';
import jwt from 'jsonwebtoken';

/**
 * Bundle the project using the local rollup.config.mjs and write the output
 * to a temporary directory as "bundle-<timestamp>.cjs".
 * Returns the absolute path to the generated bundle so tests can load it
 * with `readFile`, `vm.runInContext`, etc.
 * @returns Absolute path of the generated CommonJS bundle.
 * @example
 * ```ts
 * const bundlePath = await bundleToPath();
 * ```
 */
export async function bundleToPath(): Promise<string> {
  // eslint-disable-next-line no-unsanitized/method -- rollup.config.mjs is a trusted file in this repository
  const { default: createRollupConfig } = await import(
    pathToFileURL(path.resolve('rollup.config.mjs')).href
  );

  const testConfig = createRollupConfig({
    typescript: {
      outDir: null,
      declaration: false,
      sourceMap: true,
    },
  });

  const bundle = await rollup(testConfig);
  const tempDir = await mkdtemp(path.join(tmpdir(), 'test-bundle-'));
  const outputFile = path.join(tempDir, `bundle-${Date.now()}.cjs`);

  await copyFile(
    path.join(process.cwd(), 'tsconfig.json'),
    path.join(tempDir, 'tsconfig.json'),
  );
  try {
    await bundle.write({ ...testConfig.output, file: outputFile });
  } finally {
    await bundle.close();
  }

  return outputFile;
}

/**
 * A test helper to execute the main action script (`run`) within a
 * controlled environment. It simulates the GitHub Actions runtime by
 * preparing environment variables and mocking necessary features like
 * Job Summaries.
 * @param inputs - A record of key-value pairs representing the action's
 * inputs, equivalent to the `with` block in a workflow YAML file.
 * @param extraEnv - A record of additional environment variables to set
 * during the action's execution, used to simulate workflow context
 * like `GITHUB_REF` or `GITHUB_EVENT_NAME`.
 * @param eventPayload - The JSON payload written to the event file that
 * `GITHUB_EVENT_PATH` points to.
 * @returns A promise that resolves with the captured job summary.
 * @example
 * ```ts
 * const { summary } = await runAction({ 'github-token': 'fake-token' });
 * ```
 */
async function runAction(
  inputs: Record<string, string>,
  extraEnv: Record<string, string | null> = {},
  eventPayload: unknown = {},
): Promise<{ summary: string }> {
  const summaryDir = await mkdtemp(path.join(tmpdir(), 'test-'));
  const summaryPath = path.join(summaryDir, 'summary.md');
  await writeFile(summaryPath, '');

  const eventDir = await mkdtemp(path.join(tmpdir(), 'test-'));
  const eventPath = path.join(eventDir, 'event.json');
  await writeFile(eventPath, JSON.stringify(eventPayload));

  const env = {
    ...extraEnv,
    ...Object.fromEntries(
      Object.entries(inputs).map(([key, value]) => [
        `INPUT_${key.replaceAll(' ', '_').toUpperCase()}`,
        value,
      ]),
    ),
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_STEP_SUMMARY: summaryPath,
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_SHA: '03ab23e',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ID: '1',
    ACTIONS_STEP_DEBUG: '1',
    RUNNER_DEBUG: '1',
    ACTIONS_RUNTIME_TOKEN: jwt.sign(
      {
        scp: 'Actions.Results:some-run-id:some-job-id',
      },
      'dummy-secret',
    ),
    ACTIONS_RESULTS_URL: 'https://results.local:8080',
  };

  const wrappedRun = withEnvVars(env, async () => {
    const actionScript = await bundleToPath();
    const script = await readFile(actionScript, 'utf8');
    const context = {
      ...process.env,
      require: createRequire(import.meta.url),
      global: {},
      __filename: actionScript,
      __dirname: path.dirname(actionScript),
      module: { exports: {} },
    };
    Object.defineProperties(
      context,
      Object.getOwnPropertyDescriptors(globalThis),
    );
    vm.createContext(context);
    // eslint-disable-next-line sonarjs/code-eval -- the test runs the built action bundle in a VM context by design
    const result = vm.runInContext(script, context, {
      filename: actionScript,
      importModuleDynamically: VM.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    }) as unknown;

    await result;
    return '';
  });
  await wrappedRun();

  const summaryContent = await readFile(summaryPath, 'utf8');
  return { summary: summaryContent };
}

const matrix = [
  {
    eventName: 'push',
    ref: 'refs/heads/master',
    wait: 'true',
    shouldRun: true,
  },
  {
    eventName: 'push',
    ref: 'refs/tags/v1.0.0',
    wait: 'false',
    shouldRun: true,
  },
  {
    eventName: 'push',
    ref: 'refs/notes/commits',
    wait: '???',
    shouldRun: false,
  },
  {
    eventName: 'pull_request',
    ref: 'refs/heads/master',
    wait: 'true',
    shouldRun: false,
  },
];

test.each(matrix)(
  'runs semantic-release for event "$eventName" with ref "$ref" and wait="$wait" (shouldRun: $shouldRun)',
  ({ eventName, ref }) => {
    return withTempDir(
      withGitRepo(
        [
          'chore: init',
          'feat: some feat',
          'fix: some fix',
          'feat: another feat',
        ],
        async ({ tmp, remoteUrl }) => {
          await writeFile(
            path.join(tmp, '.releaserc.json'),
            JSON.stringify({
              branches: ['master'],
              plugins: ['@semantic-release/commit-analyzer'],
              repositoryUrl: remoteUrl,
              dryRun: true,
              ci: false,
            }),
          );

          await runAction(
            {
              'github-token': 'fake-token',
              'working-directory': tmp,
              'wait-for-checks': 'false',
            },
            {
              GITHUB_EVENT_NAME: eventName,
              GITHUB_REF: ref,
              GITHUB_SHA: 'abc123',
              GITHUB_REPOSITORY: 'user/repo',
              GITHUB_TOKEN: '*******',
              GITHUB_ACTIONS: null,
            },
          );
        },
      ),
    )();
  },
);
