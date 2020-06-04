import { promises as fs } from "fs";
import pSettled from "p-settle";
import path from "path";
import recursive from "recursive-readdir";
import { assertString } from "../assert";
import { resultInfoLogType } from "../cli";
import {
  CompilerError,
  compileToJson,
  createCompilerOptionsForChunks,
  createCompilerOptionsForPage,
} from "../compiler";
import * as compilerCoreFunctions from "../compiler-core";
import { DuckConfig } from "../duckconfig";
import { EntryConfig, loadEntryConfig } from "../entryconfig";
import { restoreDepsJs } from "../gendeps";
import { logger } from "../logger";
import { CompileErrorItem, ErrorReason } from "../report";

/**
 * @throws If compiler throws errors
 */
export async function buildJs(
  config: DuckConfig,
  entryConfigs?: readonly string[],
  printConfig = false
): Promise<ErrorReason[]> {
  let compileFn = compileToJson;
  let faastModule:
    | import("faastjs").FaastModule<typeof compilerCoreFunctions>
    | null = null;
  if (config.batch) {
    const { getFaastCompiler } = await import("../batch");
    faastModule = await getFaastCompiler(config);
    compileFn = faastModule.functions.compileToJson;
  }
  let restoringDepsJs: Promise<void> | null = null;
  const entryConfigPaths = entryConfigs
    ? entryConfigs
    : (await findEntryConfigs(assertString(config.entryConfigDir))).sort();
  let runningJobCount = 1;
  let completedJobCount = 1;
  const compileFunctions = entryConfigPaths.map(
    (entryConfigPath) => async () => {
      try {
        const entryConfig = await loadEntryConfig(entryConfigPath);
        let options: compilerCoreFunctions.ExtendedCompilerOptions;
        if (entryConfig.modules) {
          if (config.depsJs) {
            if (!restoringDepsJs) {
              restoringDepsJs = restoreDepsJs(
                config.depsJs,
                config.closureLibraryDir
              );
            }
            await restoringDepsJs;
          }
          options = await createCompilerOptionsForChunks_(entryConfig, config);
        } else {
          options = createCompilerOptionsForPage(entryConfig, config, true);
        }

        if (printConfig) {
          logger.info({
            msg: "Print config only",
            type: resultInfoLogType,
            title: "Compiler config",
            bodyObject: options,
          });
          return;
        }

        logWithCount(entryConfigPath, runningJobCount++, "Compiling");
        const [outputs, warnings] = await compileFn(options);
        const promises = outputs.map(async (output) => {
          await fs.mkdir(path.dirname(output.path), { recursive: true });
          return fs.writeFile(output.path, output.src);
        });
        await Promise.all(promises);
        logWithCount(entryConfigPath, completedJobCount++, "Compiled");
        return warnings;
      } catch (e) {
        logWithCount(entryConfigPath, completedJobCount++, "Failed");
        throw e;
      }
    }
  );

  try {
    return await waitAllAndThrowIfAnyCompilationsFailed(
      compileFunctions,
      entryConfigPaths,
      config
    );
  } finally {
    if (faastModule) {
      await faastModule.cleanup();
    }
  }

  function log(entryConfigPath: string, msg: string): void {
    const relativePath = path.relative(process.cwd(), entryConfigPath);
    logger.info(`${msg}: ${relativePath}`);
  }
  function logWithCount(
    entryConfigPath: string,
    count: number,
    msg: string
  ): void {
    log(entryConfigPath, `[${count}/${entryConfigPaths.length}] ${msg}`);
  }
}

/**
 * Wait until all promises for compilation are setteld and throw
 * a `BuildJsCompilationError` if some promises failed.
 *
 * @throws BuildJsCompilationError
 */
async function waitAllAndThrowIfAnyCompilationsFailed(
  compileFunctions: ReadonlyArray<
    () => Promise<CompileErrorItem[] | undefined>
  >,
  entryConfigPaths: readonly string[],
  config: DuckConfig
): Promise<ErrorReason[]> {
  const results = await pSettled(compileFunctions, {
    concurrency: config.concurrency || 1,
  });
  const reasons: ErrorReason[] = results
    .map((result, idx) => ({
      ...result,
      entryConfigPath: entryConfigPaths[idx],
    }))
    .map((result) => {
      if (result.isFulfilled) {
        // no errors, but it may contain warnings
        return {
          entryConfigPath: result.entryConfigPath,
          command: null,
          items: result.value || [],
        };
      }
      // has some errors
      const reason = result.reason as CompilerError;
      try {
        const { command, items } = parseErrorReason(reason, config);
        return {
          entryConfigPath: result.entryConfigPath,
          command,
          items,
        };
      } catch {
        // for invalid compiler options errors
        throw new Error(`Unexpected non-JSON error: ${reason.message}`);
      }
    })
    .filter((result) => result.items.length > 0);
  if (results.filter((result) => result.isRejected).length > 0) {
    throw new BuildJsCompilationError(reasons, results.length);
  }
  return reasons;

  function parseErrorReason(
    reason: CompilerError & { info?: Record<string, any> },
    config: DuckConfig
  ): { command: string; items: CompileErrorItem[] } {
    const { message: stderr, info } = reason;
    const message = config.batch && info ? info.message : stderr;
    const [command, , ...messages] = message.split("\n");
    return { command, items: JSON.parse(messages.join("\n")) };
  }
}
export class BuildJsCompilationError extends Error {
  reasons: readonly ErrorReason[];
  constructor(reasons: readonly ErrorReason[], totalSize: number) {
    super(`Failed to compile (${reasons.length}/${totalSize})`);
    this.name = "BuildJsCompilationError";
    this.reasons = reasons;
  }
}

async function findEntryConfigs(entryConfigDir: string): Promise<string[]> {
  const files = await recursive(entryConfigDir);
  return files.filter((file) => /\.json$/.test(file));
}

async function createCompilerOptionsForChunks_(
  entryConfig: EntryConfig,
  config: DuckConfig
): Promise<compilerCoreFunctions.ExtendedCompilerOptions> {
  function createModuleUris(chunkId: string): string[] {
    const moduleProductionUri = assertString(
      entryConfig["module-production-uri"]
    );
    return [moduleProductionUri.replace(/%s/g, chunkId)];
  }
  const { options } = await createCompilerOptionsForChunks(
    entryConfig,
    config,
    true,
    createModuleUris
  );
  return options;
}
