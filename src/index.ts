import * as core from '@actions/core';

function getBooleanInput(name: string, defaultValue = false): boolean {
  const raw = core.getInput(name).toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return defaultValue;
}

async function run(): Promise<void> {
  try {
    const token = core.getInput('github-token', { required: true });
    const waitForChecks = getBooleanInput('wait-for-checks', true);
    const workingDirectory = core.getInput('working-directory') || '.';

    core.info(`Token: ${token ? '***' : '[missing]'}`);
    core.info(`Wait for checks: ${waitForChecks}`);
    core.info(`Working directory: ${workingDirectory}`);

    core.info('Action ran successfully.');
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed('Unexpected error');
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
run();
