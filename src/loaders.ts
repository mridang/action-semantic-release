/**
 * @file Cosmiconfig loaders that install the npm dependencies declared by
 * semantic-release configuration files before the configuration is used.
 */
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  startGroup,
  endGroup,
  info,
  debug as logDebug,
  error as logError,
} from '@actions/core';
import type { Loader } from 'cosmiconfig';
import { defaultLoaders } from 'cosmiconfig';

/* eslint-disable jsdoc/require-rejects -- the preset rejects the @rejects tag, so rejections are documented with @throws */

/**
 * Checks whether anything exists at the given path.
 * @param target - The absolute path to check.
 * @returns `true` if a file or directory exists at the path, otherwise `false`.
 * @example
 * ```ts
 * const hasPackageJson = await pathExists(path.join(cwd, 'package.json'));
 * ```
 */
async function pathExists(target: string): Promise<boolean> {
  return access(target)
    .then(() => true)
    .catch(() => false);
}

/**
 * Reads the plugin names declared in a parsed configuration. Both plain
 * strings and `[name, options]` tuples are accepted.
 * @param config - The parsed configuration, which may be any value.
 * @returns The trimmed plugin names, or an empty array when none are declared.
 * @example
 * ```ts
 * extractPluginNames({ plugins: ['@semantic-release/npm', ['@semantic-release/git', {}]] });
 * // => ['@semantic-release/npm', '@semantic-release/git']
 * ```
 */
function extractPluginNames(config: unknown): string[] {
  if (typeof config !== 'object' || config === null) {
    return [];
  }
  const rawPlugins = (config as { plugins?: unknown }).plugins;
  if (!Array.isArray(rawPlugins)) {
    return [];
  }
  return rawPlugins
    .map((entry: unknown) => {
      if (typeof entry === 'string') {
        return entry.trim();
      } else if (Array.isArray(entry) && typeof entry[0] === 'string') {
        return entry[0].trim();
      } else {
        return null;
      }
    })
    .filter((p): p is string => !!p);
}

/**
 * Writes a temporary package.json that lists the given plugins as dependencies.
 * Versions are taken from an `@version` suffix, defaulting to `*`.
 * @param cwd - The directory that holds the configuration file.
 * @param plugins - Plugin names, each optionally suffixed with `@version`.
 * @throws If a package.json already exists in the directory.
 * @example
 * ```ts
 * await writePluginPackageJson(process.cwd(), ['@semantic-release/npm@13.1.1']);
 * ```
 */
async function writePluginPackageJson(
  cwd: string,
  plugins: string[],
): Promise<void> {
  const pkgPath = path.join(cwd, 'package.json');
  if (await pathExists(pkgPath)) {
    throw new Error(`Cannot create package.json in ${cwd}, file exists.`);
  }

  const dependencies = Object.fromEntries(
    plugins.map((entry) => {
      const atIndex = entry.lastIndexOf('@');
      const [name, version] =
        atIndex > 0 && entry.startsWith('@')
          ? [entry.slice(0, atIndex), entry.slice(atIndex + 1)]
          : [entry, '*'];
      return [name, version];
    }),
  );

  logDebug(`Writing temporary package.json to ${pkgPath}`);
  await writeFile(
    pkgPath,
    JSON.stringify(
      {
        name: 'semantic-release-temp',
        version: '1.0.0',
        dependencies,
      },
      null,
      2,
    ),
  );
}

/**
 * Creates a loader that extracts plugin dependencies from declarative configs
 * and generates a package.json file with versions if specified.
 *
 * Will throw if a package.json already exists in the directory.
 * @param loader - The base loader to parse the configuration file.
 * @returns A loader that prepares a package.json for npm install.
 * @example
 * ```ts
 * const loadYaml = declarativeLoader(defaultLoaders['.yaml']);
 * const config = await loadYaml('/project/.releaserc.yaml', content);
 * ```
 */
function declarativeLoader(loader: Loader): Loader {
  return async (filepath, content) => {
    logDebug(`Loading declarative config: ${filepath}`);
    const config = await loader(filepath, content);
    const plugins = extractPluginNames(config);

    if (plugins.length > 0) {
      await writePluginPackageJson(path.dirname(filepath), plugins);
    }

    return config;
  };
}

/**
 * Runs a shell command with its output inherited from this process.
 * @param command - The shell command to run.
 * @param cwd - The directory to run the command in.
 * @returns A promise that resolves when the command exits with status 0.
 * @throws If the command cannot start or exits with a non-zero status.
 * @example
 * ```ts
 * await runInherited('npm --version', process.cwd());
 * ```
 */
function runInherited(command: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, stdio: 'inherit', shell: true });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed: ${command}`));
      }
    });
  });
}

/**
 * Creates a loader that runs `npm install` in the config file's directory.
 * If allowForce is true, it will use the --force flag.
 * @param loader - The base loader to parse the configuration file.
 * @param allowForce - Whether to use `npm install --force`.
 * @returns A loader that installs dependencies using npm.
 * @example
 * ```ts
 * const loadJs = imperativeLoader(defaultLoaders['.js'], false);
 * const config = await loadJs('/project/release.config.js', content);
 * ```
 */
function imperativeLoader(loader: Loader, allowForce: boolean): Loader {
  return async (filepath, content) => {
    logDebug(`Loading imperative config: ${filepath}`);
    const config = await loader(filepath, content);
    const cwd = path.dirname(filepath);

    startGroup('Installing dependencies');
    try {
      const command = allowForce
        ? 'npm install --force --no-audit --no-progress --no-fund --quiet'
        : 'npm install --no-audit --no-progress --no-fund --quiet';

      info(`Running command: ${command}`);
      await runInherited(command, cwd);
    } catch (error) {
      logError('npm install failed');
      if (error instanceof Error) {
        logError(error.message);
      }
      throw error;
    } finally {
      endGroup();
    }

    return config;
  };
}

/**
 * Creates a loaders object for cosmiconfig, configured with the allowForce flag.
 * @param allowForce - If true, enables force-install and overwriting package.json.
 * @returns A cosmiconfig loaders object.
 * @example
 * ```ts
 * const explorer = cosmiconfig('release', { loaders: createLoaders(false) });
 * ```
 */
export function createLoaders(allowForce = false) {
  const dLoader = (loader: Loader) => declarativeLoader(loader);
  const iLoader = (loader: Loader) => imperativeLoader(loader, allowForce);

  return {
    ...defaultLoaders,
    '.json': iLoader(dLoader(defaultLoaders['.json'])),
    '.yaml': iLoader(dLoader(defaultLoaders['.yaml'])),
    '.yml': iLoader(dLoader(defaultLoaders['.yml'])),
    noExt: iLoader(dLoader(defaultLoaders['.yaml'])),
    '.js': iLoader(defaultLoaders['.js']),
    '.cjs': iLoader(defaultLoaders['.cjs']),
    '.mjs': iLoader(defaultLoaders['.mjs']),
    '.ts': iLoader(defaultLoaders['.ts']),
  };
}
/* eslint-enable jsdoc/require-rejects -- end of the documented rejection scope */
