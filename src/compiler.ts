import flat from 'array.prototype.flat';
import {stripIndents} from 'common-tags';
import {compiler as ClosureCompiler} from 'google-closure-compiler';
import {depGraph} from 'google-closure-deps';
import {assertNonNullable} from './assert';
import {DuckConfig} from './duckconfig';
import {createDag, EntryConfig, PlovrMode} from './entryconfig';
import {getClosureLibraryDependencies, getDependencies} from './gendeps';
import {Dag} from './dag';

export interface CompilerOptions {
  [idx: string]: any;
  dependency_mode?: string;
  entry_point?: string[];
  compilation_level?: 'BUNDLE' | 'WHITESPACE' | 'WHITESPACE_ONLY' | 'SIMPLE' | 'ADVANCED';
  js?: string[];
  js_output_file?: string;
  // chunk or module: `name:num-js-files[:[dep,...][:]]` ex) chunk1:3:app
  chunk?: string[];
  language_in?: string;
  language_out?: string;
  json_streams?: 'IN' | 'OUT' | 'BOTH';
  warning_level?: string;
  debug?: boolean;
  formatting?: string[];
  define?: string[];
  // chunkname:wrappercode
  chunk_wrapper?: string[];
  chunk_output_path_prefix?: string;
  isolation_mode?: 'NONE' | 'IIFE';
}

export function toCompilerOptions(entryConfig: EntryConfig): CompilerOptions {
  const opts: CompilerOptions = {};
  function copy(entryKey: keyof EntryConfig, closureKey = entryKey.replace(/-/g, '_')) {
    if (entryKey in entryConfig) {
      opts[closureKey] = entryConfig[entryKey];
    }
  }
  // TODO: load from args
  const isServeCommand = process.argv.includes('serve');

  copy('language-in');
  copy('language-out');
  copy('externs');
  copy('level', 'warning_level');
  copy('debug');
  if (!isServeCommand) {
    copy('output-file', 'js_output_file');
  }

  if (entryConfig.mode === PlovrMode.RAW) {
    opts.compilation_level = 'WHITESPACE';
  } else {
    opts.compilation_level = entryConfig.mode;
  }

  if (entryConfig.modules) {
    // for chunks
    opts.dependency_mode = 'NONE';
    if (isServeCommand) {
      opts.json_streams = 'OUT';
    }
  } else {
    // for pages
    opts.dependency_mode = 'PRUNE';
    opts.js = entryConfig.paths;
    opts.entry_point = entryConfig.inputs;
    // TODO: consider `global-scope-name`
    opts.isolation_mode = 'IIFE';
  }

  const formatting: string[] = [];
  if (entryConfig['pretty-print']) {
    formatting.push('PRETTY_PRINT');
  }
  if (entryConfig['print-input-delimiter']) {
    formatting.push('PRINT_INPUT_DELIMITER');
  }
  if (formatting.length > 0) {
    opts.formatting = formatting;
  }

  if (entryConfig.define) {
    const defines: string[] = [];
    for (const key in entryConfig.define) {
      const value = entryConfig.define[key];
      defines.push(`${key}=${value}`);
    }
    opts.define = defines;
  }

  if (entryConfig['module-output-path']) {
    const outputPath = entryConfig['module-output-path'];
    const suffix = '%s.js';
    if (!outputPath.endsWith(suffix)) {
      throw new TypeError(
        `"moduleOutputPath" must end with "${suffix}", but actual "${outputPath}"`
      );
    }
    opts.chunk_output_path_prefix = outputPath.slice(0, suffix.length * -1);
  }

  return opts;
}

export async function compile(opts: CompilerOptions): Promise<string> {
  const compiler = new ClosureCompiler(opts as any);
  return new Promise((resolve, reject) => {
    compiler.run((exitCode: number, stdout: string, stderr?: string) => {
      if (stderr) {
        return reject(new CompilerError(stderr, exitCode));
      }
      resolve(stdout);
    });
  });
}

class CompilerError extends Error {
  exitCode: number;
  constructor(msg: string, exitCode: number) {
    super(msg);
    this.name = 'CompilerError';
    this.exitCode = exitCode;
  }
}

export async function createComiplerOptionsForChunks(
  entryConfig: EntryConfig,
  config: DuckConfig,
  createModuleUris: (chunkId: string) => string[]
): Promise<{options: CompilerOptions; sortedChunkIds: string[]; rootChunkId: string}> {
  // TODO: separate EntryConfigChunks from EntryConfig
  const modules = assertNonNullable(entryConfig.modules);
  const dependencies = flat(
    await Promise.all([
      getDependencies(entryConfig, config.closureLibraryDir),
      getClosureLibraryDependencies(config.closureLibraryDir),
    ])
  );
  const dag = createDag(entryConfig);
  const sortedChunkIds = dag.getSortedIds();
  const chunkToTransitiveDepPathSet = findTransitiveDeps(sortedChunkIds, dependencies, modules);
  const chunkToInputPathSet = splitDepsIntoChunks(sortedChunkIds, chunkToTransitiveDepPathSet, dag);
  const opts = toCompilerOptions(entryConfig);
  opts.js = flat([...chunkToInputPathSet.values()].map(inputs => [...inputs]));
  opts.chunk = sortedChunkIds.map(id => {
    const numOfInputs = chunkToInputPathSet.get(id)!.size;
    return `${id}:${numOfInputs}:${modules[id].deps.join(',')}`;
  });
  const {moduleInfo, moduleUris, rootId} = convertModuleInfos(entryConfig, createModuleUris);
  const wrapper = stripIndents`var PLOVR_MODULE_INFO = ${JSON.stringify(moduleInfo)};
var PLOVR_MODULE_URIS = ${JSON.stringify(moduleUris)};
%output%`;
  opts.chunk_wrapper = [`${rootId}:${wrapper}`];
  return {options: opts, sortedChunkIds, rootChunkId: rootId};
}

function findTransitiveDeps(
  sortedChunkIds: string[],
  dependencies: depGraph.Dependency[],
  modules: {[id: string]: {inputs: string[]; deps: string[]}}
): Map<string, Set<string>> {
  const pathToDep = new Map(
    dependencies.map(dep => [dep.path, dep] as [string, depGraph.Dependency])
  );
  const graph = new depGraph.Graph(dependencies);
  const chunkToTransitiveDepPathSet: Map<string, Set<string>> = new Map();
  sortedChunkIds.forEach(chunkId => {
    const chunkConfig = modules[chunkId];
    const entryPoints = chunkConfig.inputs.map(input =>
      assertNonNullable(
        pathToDep.get(input),
        `entryConfig.paths does not include the inputs: ${input}`
      )
    );
    const depPaths = graph.order(...entryPoints).map(dep => dep.path);
    chunkToTransitiveDepPathSet.set(chunkId, new Set(depPaths));
  });
  return chunkToTransitiveDepPathSet;
}

function splitDepsIntoChunks(
  sortedChunkIds: string[],
  chunkToTransitiveDepPathSet: Map<string, Set<string>>,
  dag: Dag
) {
  const chunkToInputPathSet: Map<string, Set<string>> = new Map();
  sortedChunkIds.forEach(chunk => {
    chunkToInputPathSet.set(chunk, new Set());
  });
  for (const targetDepPathSet of chunkToTransitiveDepPathSet.values()) {
    for (const targetDepPath of targetDepPathSet) {
      const chunkIdsWithDep: string[] = [];
      chunkToTransitiveDepPathSet.forEach((depPathSet, chunkId) => {
        if (depPathSet.has(targetDepPath)) {
          chunkIdsWithDep.push(chunkId);
        }
      });
      const targetChunk = dag.getLcaNode(...chunkIdsWithDep);
      assertNonNullable(chunkToInputPathSet.get(targetChunk.id)).add(targetDepPath);
    }
  }
  return chunkToInputPathSet;
}

export function convertModuleInfos(
  entryConfig: EntryConfig,
  createModuleUris: (id: string) => string[]
): {moduleInfo: {[id: string]: string[]}; moduleUris: {[id: string]: string[]}; rootId: string} {
  let rootId: string | null = null;
  const modules = assertNonNullable(entryConfig.modules);
  const moduleInfo: {[id: string]: string[]} = {};
  const moduleUris: {[id: string]: string[]} = {};
  for (const id in modules) {
    const module = modules[id];
    moduleInfo[id] = module.deps;
    moduleUris[id] = createModuleUris(id);
    if (module.deps.length === 0) {
      if (rootId) {
        throw new Error('Many root modules');
      }
      rootId = id;
    }
  }
  if (!rootId) {
    throw new Error('No root module');
  }
  return {moduleInfo, moduleUris, rootId};
}
