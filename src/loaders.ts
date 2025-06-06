/* eslint-disable testing-library/no-debugging-utils */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import { startGroup, endGroup, info, debug, error } from '@actions/core';
import type { Loader } from 'cosmiconfig';
import { defaultLoaders } from 'cosmiconfig';

/**
 * Creates a loader that extracts plugin dependencies from declarative configs
 * and generates a package.json file with versions if specified.
 *
 * Will throw if a package.json already exists in the directory.
 *
 * @param loader - The base loader to parse the configuration file.
 * @returns A loader that prepares a package.json for npm install.
 */
function declarativeLoader(loader: Loader): Loader {
  return async (filepath, content) => {
    debug(`Loading declarative config: ${filepath}`);
    const config = await loader(filepath, content);
    const cwd = dirname(filepath);

    if (typeof config === 'object' && config !== null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawPlugins = (config as any).plugins;
      if (Array.isArray(rawPlugins)) {
        const plugins = rawPlugins
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

        if (plugins.length > 0) {
          const pkgPath = join(cwd, 'package.json');
          if (existsSync(pkgPath)) {
            throw new Error(
              `Cannot create package.json in ${cwd}, file exists.`,
            );
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

          debug(`Writing temporary package.json to ${pkgPath}`);
          writeFileSync(
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
      }
    }

    return config;
  };
}

/**
 * Creates a loader that runs `npm install` in the config file's directory.
 * If allowForce is true, it will use the --force flag.
 *
 * @param loader - The base loader to parse the configuration file.
 * @param allowForce - Whether to use `npm install --force`.
 * @returns A loader that installs dependencies using npm.
 */
function imperativeLoader(loader: Loader, allowForce: boolean): Loader {
  return async (filepath, content) => {
    debug(`Loading imperative config: ${filepath}`);
    const config = await loader(filepath, content);
    const cwd = dirname(filepath);

    startGroup('Installing dependencies');
    try {
      // MODIFIED: Append --force to the command if allowForce is true.
      const command = allowForce
        ? 'npm install --force --no-audit --no-progress --no-fund --quiet'
        : 'npm install --no-audit --no-progress --no-fund --quiet';

      info(`Running command: ${command}`);
      execSync(command, {
        cwd,
        stdio: 'inherit',
      });
    } catch (err) {
      error('npm install failed');
      if (err instanceof Error) {
        error(err.message);
      }
      throw err;
    } finally {
      endGroup();
    }

    return config;
  };
}

/**
 * REFACTORED: Creates a loaders object for cosmiconfig, configured with the
 * allowForce flag.
 *
 * @param allowForce - If true, enables force-install and overwriting package.json.
 * @returns A cosmiconfig loaders object.
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
