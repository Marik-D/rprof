import moduleApi = require('module');
import { resolve } from 'path'
import { argv, hrtime } from 'process';
import { sync as findPkg } from 'pkg-up'
import { readFileSync } from 'fs';
import { entries } from 'lodash';

function _copyProperties(dst: any, src: any): void {
  for (const prop of Object.keys(src)) {
    dst[prop] = src[prop];
  }
}

function findImportedModuleInfo(parent: NodeModule, importedModule: unknown): NodeModule | undefined {
  const children: NodeModule[] = parent.children || [];
  for (const child of children) {
    if (child.exports === importedModule) {
      return child;
    }
  }

  return undefined;
}

interface ModuleImport {
  imported: string;
  parent: string;
  time: number;
}

interface ModuleInfo {
  id: string;
  filename: string;
  importedBy: ModuleImport[];
  totalTime: number;
}

interface ExpandedModuleInfo extends ModuleInfo {
  children: ModuleImport[];
  totalChildTime: number;
  ownTime: number,
  packageName?: string
  packagePath?: string
  /** @deprecated */
  importedPackages: ModuleImport[];
}

interface PackageInfo {
  name: string;
  path: string;
  modules: ExpandedModuleInfo[];
  ownTime: number;
  totalTime: number;
  children: ModuleImport[];
}

const loadedModules = new Map<string, ModuleInfo>();

function shortenPath(path: string) {
  if(path.startsWith(process.cwd())) {
    return path.substr(process.cwd().length + 1);
  } else {
    return path;
  }
}

function installHook(): void {
  const realRequire: NodeJS.Require = moduleApi.Module.prototype.require;

  
  function hookedRequire(this: NodeModule, moduleName: string): unknown {
    // NOTE: The "this" pointer is the calling NodeModule, so we rely on closure
    // variable here.
    const callingModuleInfo: NodeModule = this;

    // console.log({ callingModuleInfo, moduleName });

    const before = Date.now()

    // Paranoidly use "arguments" in case some implementor passes additional undocumented arguments
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const importedModule: unknown = (realRequire as any).apply(callingModuleInfo, arguments);

    const elapsed = Date.now() - before;
    
    // console.log({ callingModuleInfo, moduleName, after: true });


    // Find the info for the imported module
    const importedModuleInfo = findImportedModuleInfo(callingModuleInfo, importedModule);

    // Filter out built-in modules
    if (importedModuleInfo !== undefined) {
      if (!importedModuleInfo.filename) {
        throw new Error('Missing filename for ' + moduleName);
      }

      if(!loadedModules.has(importedModuleInfo.id)) {
        loadedModules.set(importedModuleInfo.id, {
          id: importedModuleInfo.id,
          filename: importedModuleInfo.filename,
          importedBy: [],
          totalTime: elapsed,
        });
      }
      const existing = loadedModules.get(importedModuleInfo.id);
      existing.importedBy.push({
        parent: callingModuleInfo.id,
        imported: importedModuleInfo.id,
        time: elapsed
      });
    }

    return importedModule;
  }

  _copyProperties(hookedRequire, realRequire);
  moduleApi.Module.prototype.require = hookedRequire as NodeJS.Require;
}

installHook();

const moduleName = require.resolve(process.argv[2], { paths: [process.cwd()] });

// console.log(`Loading module ${moduleName}\n\n`)


// const start = Date.now();

require(moduleName)

// console.log(`\n\nTOTAL TIME: ${Date.now() - start} ms\n\n`)

const PACKAGE_FILTER: string | undefined = '@dxos'

const pkgMatch = (pkgName: string) => !PACKAGE_FILTER || pkgName.startsWith(PACKAGE_FILTER)

function gatherExpandedModuleInfo(loadedModules: Map<string, ModuleInfo>): Map<string, ExpandedModuleInfo> {
  const modulesEx = new Map<string, ExpandedModuleInfo>();

  for(const mod of loadedModules.values()) {
    const children: ModuleImport[] = [];
    let totalChildrenTime = 0;
    for(const modEntry of loadedModules.values()) {
      const imp = modEntry.importedBy.find(x => x.parent === mod.id)
      if(imp) {
        children.push(imp)
        totalChildrenTime += imp.time;
      }
    }

    let packageName = undefined
    const packagePath = findPkg({ cwd: mod.filename });
    if(packagePath) {
      packageName = JSON.parse(readFileSync(packagePath, 'utf8')).name;
    }

    let totalTime = 0;
    for(const imp of mod.importedBy) {
      totalTime = Math.max(totalTime, imp.time);
    }

    modulesEx.set(mod.id, {
      ...mod,
      children: children.sort((a, b) => b.time - a.time),
      importedPackages: [], // Will be filled out in the next step.
      totalTime,
      totalChildTime: totalChildrenTime,
      ownTime: totalTime - totalChildrenTime,
      packageName,
      packagePath: packagePath ?? undefined,
    })
  }

  return modulesEx
}

function buildPackageGraph(mods: Map<string, ExpandedModuleInfo>): Map<string, PackageInfo> {
  const packages = new Map<string, PackageInfo>();

  for(const mod of mods.values()) {
    if(!mod.packagePath) {
      continue;
    }

    const packageName = mod.packageName;
    const packagePath = mod.packagePath;

    if(!packages.has(packageName)) {
      packages.set(packageName, {
        name: packageName,
        path: packagePath,
        modules: [],
        ownTime: 0,
        totalTime: 0,
        children: [],
      });
    }

    const importedPackages = new Set<ModuleImport>();
    const visitedImports = new Set<string>();

    function visitImport(imp: ModuleImport) {
      const childEntry = modulesEx.get(imp.imported);
      if(childEntry.packagePath === mod.packagePath) {
        if(!visitedImports.has(childEntry.id)) {
          visitedImports.add(childEntry.id);
          for(const childImp of childEntry.children) {
            visitImport(childImp)
          }
        }
      } else {
        importedPackages.add(imp)
      }
    }

    for(const childImp of mod.children) {
      visitImport(childImp)
    }

    const packageEntry = packages.get(packageName);
    packageEntry.modules.push(mod);
    packageEntry.ownTime += mod.ownTime;
    packageEntry.totalTime += mod.ownTime;
    packageEntry.children = packageEntry.children.concat(Array.from(importedPackages));
  }

  for(const packageEntry of packages.values()) {
    const children = new Map<string, ModuleImport>();
    for(const childImp of new Set(packageEntry.children)) {
      const targetEntry = modulesEx.get(childImp.imported)!;
      if(!children.has(targetEntry.packagePath)) {
        children.set(targetEntry.packagePath, {
          parent: packageEntry.name,
          imported: targetEntry.packageName,
          time: 0,
        });
      }
      const childEntry = children.get(targetEntry.packagePath);
      childEntry!.time += childImp.time;
      packageEntry.totalTime += childImp.time;
    }

    packageEntry.children = Array.from(children.values());
  }

  return packages;
}

const modulesEx = gatherExpandedModuleInfo(loadedModules);
const pkgGraph = buildPackageGraph(modulesEx);

const printedModuleIds = new Set<string>();

const argPackages = argv.includes('--packages')
const argGraph = argv.includes('--graph')

if(argPackages) {
  printGraph()
} else if(argGraph) {
  printPackage(modulesEx.get(moduleName)!.importedBy[0])
} else {
  printModule(modulesEx.get(moduleName)!.importedBy[0])
}


function printModule(imp: ModuleImport, pad = '') {
  const entry = modulesEx.get(imp.imported);
  if(!entry) {
    console.log(`${pad}${imp.imported} - NOT FOUND`)
    return;
  }

  if(printedModuleIds.has(entry.id)) {
    console.log(`${pad}${shortenPath(entry.filename)} total=${entry.totalTime}ms own=${entry.ownTime}ms imp=${imp.time}ms REPEAT`);
  } else {
    console.log(`${pad}${shortenPath(entry.filename)} total=${entry.totalTime}ms own=${entry.ownTime}ms imp=${imp.time}ms`);
    printedModuleIds.add(entry.id);
    for(const child of entry.children) {
      printModule(child, pad + '  ')
    }
  }
}

function printPackage(imp: ModuleImport, pad = '') {
  const entry = modulesEx.get(imp.imported);
  if(!entry) {
    console.log(`${pad}${imp.imported} - NOT FOUND`)
    return;
  }

  if(printedModuleIds.has(entry.id)) {
    console.log(`${pad}${entry.packageName ?? shortenPath(entry.filename)} total=${entry.totalTime}ms own=${entry.ownTime}ms imp=${imp.time}ms REPEAT`);
  } else {
    console.log(`${pad}${entry.packageName ?? shortenPath(entry.filename)} total=${entry.totalTime}ms own=${entry.ownTime}ms imp=${imp.time}ms`);
    printedModuleIds.add(entry.id);
    for(const child of entry.importedPackages) {
      printPackage(child, pad + '  ')
    }
  }
}

function getColor(time: number) {
  if(time > 50) {
    return 'red';
  } else if(time > 20) {
    return 'orange';
  } else {
    return 'black'
  }
}

function printNode(entry: PackageInfo, dependencyTime: number) {
  const label = `${entry.name}\\ntotal=${entry.totalTime}ms own=${entry.ownTime}ms deps=${dependencyTime}ms`

  console.log(`  "${entry.path}" [color="${getColor(entry.totalTime)}" label="${label}"]`)
}

function printGraph() {
  console.log('digraph {')

  for(const entry of pkgGraph.values()) {
    if(!pkgMatch(entry.name)) {
      continue;
    }

    let dependencyTime = 0;
    for(const child of entry.children) {
      const childEntry = pkgGraph.get(child.imported);
      if(!pkgMatch(childEntry.name)) {
        dependencyTime += child.time;
        continue;
      }
      if(child.time > 50) {
        console.log(`  "${entry.path}" -> "${childEntry.path}" [label="${child.time}ms" color="${getColor(child.time)}"]`)
      } else {
        console.log(`  "${entry.path}" -> "${childEntry.path}" [label="${child.time}ms"]`)
      }
    }
    printNode(entry, dependencyTime)

  }
  

  console.log('}')
}


