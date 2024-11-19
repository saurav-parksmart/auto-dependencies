'use strict';

const path = require('path');

const { paperwork } = require('precinct');
const resolve = require('resolve');
const readPkgUp = require('read-pkg-up');
const requirePackageName = require('require-package-name');
const glob = require('glob');

function ignoreMissing(dependency, optional, peerDependenciesMeta) {
  return optional && dependency in optional
    || peerDependenciesMeta && dependency in peerDependenciesMeta && peerDependenciesMeta[dependency].optional;
}

function loadModuleAliases(servicePath) {
  try {
    const pkg = readPkgUp.sync({ cwd: servicePath });
    if (pkg && pkg.packageJson && pkg.packageJson._moduleAliases) {
      return Object.entries(pkg.packageJson._moduleAliases).reduce((aliases, [alias, target]) => {
        aliases[alias] = path.resolve(servicePath, target);
        return aliases;
      }, {});
    }
  } catch (e) {
    // Silently fail if no aliases are found
  }
  return {};
}

function resolveAlias(name, aliases) {
  const alias = Object.keys(aliases).find(key => name.startsWith(key));
  if (alias) {
    const resolvedPath = path.join(aliases[alias], name.slice(alias.length));
    return resolvedPath;
  }
  return null;
}

module.exports = function(filename, serverless, cache) {
  const servicePath = serverless.config.servicePath;
  const modulePaths = new Set();
  const filePaths = new Set();
  const modulesToProcess = [];
  const localFilesToProcess = [filename];

  function handle(name, basedir, optionalDependencies, peerDependenciesMeta) {
    const moduleName = requirePackageName(name.replace(/\\/, '/'));
    const cacheKey = `${basedir}:${name}`;

    if (cache && cache.has(cacheKey)) {
      return;
    }

    try {
      const pathToModule = resolve.sync(path.join(moduleName, 'package.json'), { basedir });
      const pkg = readPkgUp.sync({ cwd: pathToModule });

      if (pkg) {
        modulesToProcess.push(pkg);
        if (cache) {
          cache.add(cacheKey);
        }

      } else {
        // TODO: should we warn here?
      }
    } catch (e) {
      if (e.code === 'MODULE_NOT_FOUND') {
        if (ignoreMissing(moduleName, optionalDependencies, peerDependenciesMeta)) {
          serverless.cli.log(`[serverless-plugin-include-dependencies]: WARNING missing optional dependency: ${moduleName}`);
          return null;
        }
        try {
          // this resolves the requested import also against any set up NODE_PATH extensions, etc.
          
          const aliases = loadModuleAliases(servicePath);
          const aliasResolvedPath = resolveAlias(name, aliases);
          if (aliasResolvedPath) {
            if (!filePaths.has(aliasResolvedPath)) {
              localFilesToProcess.push(aliasResolvedPath);
              filePaths.add(aliasResolvedPath);
            }
            if (cache) cache.add(cacheKey);
            return;
          }
          
          const resolved = require.resolve(name);
          localFilesToProcess.push(resolved);

          if (cache) {
            cache.add(cacheKey);
          }

          return;
        } catch(e) {
          throw new Error(`[serverless-plugin-include-dependencies]: Could not find npm package: ${moduleName}`);
        }
      }
      throw e;
    }
  }

  while (localFilesToProcess.length) {
    const currentLocalFile = localFilesToProcess.pop();

    if (filePaths.has(currentLocalFile)) {
      continue;
    }   
    filePaths.add(currentLocalFile);
    paperwork(currentLocalFile, { includeCore: false }).forEach(dependency => {
      if (dependency.indexOf('.') === 0) {
        filePaths.add(dependency);
        const abs = resolve.sync(dependency, {
          basedir: path.dirname(currentLocalFile)
        });
        localFilesToProcess.push(abs);
      } else {
        handle(dependency, servicePath);
      }
    });
  }

  while (modulesToProcess.length) {
    const currentModule = modulesToProcess.pop();
    const currentModulePath = path.join(currentModule.path, '..');

    if (modulePaths.has(currentModulePath)) {
      continue;
    }

    modulePaths.add(currentModulePath);

    const { packageJson } = currentModule;

    ['dependencies', 'peerDependencies', 'optionalDependencies'].forEach(key => {
      const dependencies = packageJson[key];

      if (dependencies) {
        Object.keys(dependencies).forEach(dependency => {
          handle(dependency, currentModulePath, packageJson.optionalDependencies, packageJson.peerDependenciesMeta);
        });
      }
    });
  }

  modulePaths.forEach(modulePath => {
    const moduleFilePaths = glob.sync(path.join(modulePath, '**'), {
      nodir: true,
      ignore: path.join(modulePath, 'node_modules', '**'),
      absolute: true,
      windowsPathsNoEscape: true,
    });

    moduleFilePaths.forEach(moduleFilePath => {
      filePaths.add(moduleFilePath);
    });
  });
  return Array.from(filePaths).map(file => file.replace(/\\/, '/'));
};
