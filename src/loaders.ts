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
 *
 * @param loader - The base loader to parse the configuration file.
 * @returns A loader that installs dependencies using npm.
 */
function imperativeLoader(loader: Loader): Loader {
  return async (filepath, content) => {
    debug(`Loading imperative config: ${filepath}`);
    const config = await loader(filepath, content);
    const cwd = dirname(filepath);

    startGroup('Installing dependencies');
    try {
      info('Running npm install');
      execSync('npm install --no-audit --no-progress --no-fund --quiet', {
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
 * Loaders for all supported config file extensions, enhanced with
 * declarative and imperative behavior where appropriate.
 */
export const loaders = {
  ...defaultLoaders,
  '.json': imperativeLoader(declarativeLoader(defaultLoaders['.json'])),
  '.yaml': imperativeLoader(declarativeLoader(defaultLoaders['.yaml'])),
  '.yml': imperativeLoader(declarativeLoader(defaultLoaders['.yml'])),
  noExt: imperativeLoader(declarativeLoader(defaultLoaders['.yaml'])),
  '.js': imperativeLoader(defaultLoaders['.js']),
  '.cjs': imperativeLoader(defaultLoaders['.cjs']),
  '.mjs': imperativeLoader(defaultLoaders['.mjs']),
  '.ts': imperativeLoader(defaultLoaders['.ts']),
};
