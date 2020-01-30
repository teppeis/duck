import fs from "fs";
import pLimit from "p-limit";
import pSettled from "p-settle";
import path from "path";
import recursive from "recursive-readdir";
import { promisify } from "util";
import { assertString } from "../assert";
import { resultInfoLogType } from "../cli";
import {
  CompilerError,
  compileToJson,
  createCompilerOptionsForChunks,
  createCompilerOptionsForPage
} from "../compiler";
import * as compilerCoreFunctions from "../compiler-core";
import { DuckConfig } from "../duckconfig";
import { EntryConfig, loadEntryConfig } from "../entryconfig";
import { restoreDepsJs } from "../gendeps";
import { logger } from "../logger";
import { CompileErrorItem, ErrorReason } from "../report";

const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);

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
  const limit = pLimit(config.concurrency || 1);
  let runningJobCount = 1;
  let completedJobCount = 1;
  const promises = entryConfigPaths.map(entryConfigPath =>
    limit(async () => {
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
            bodyObject: options
          });
          return;
        }

        logWithCount(entryConfigPath, runningJobCount++, "Compiling");
        const [outputs, warnings] = await compileFn(options);
        const promises = outputs.map(async output => {
          await mkdir(path.dirname(output.path), { recursive: true });
          return writeFile(output.path, output.src);
        });
        await Promise.all(promises);
        logWithCount(entryConfigPath, completedJobCount++, "Compiled");
        return warnings;
      } catch (e) {
        logWithCount(entryConfigPath, completedJobCount++, "Failed");
        throw e;
      }
    })
  );

  try {
    return await waitAllAndThrowIfAnyCompilationsFailed(
      promises,
      entryConfigPaths
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
  promises: ReadonlyArray<Promise<CompileErrorItem[] | undefined>>,
  entryConfigPaths: readonly string[]
): Promise<ErrorReason[]> {
  const results = await pSettled(promises);
  const reasons: ErrorReason[] = results
    .map((result, idx) => ({
      ...result,
      entryConfigPath: entryConfigPaths[idx]
    }))
    .map(result => {
      if (result.isFulfilled) {
        // no errors, but it may contain warnings
        return {
          entryConfigPath: result.entryConfigPath,
          command: null,
          items: result.value || []
        };
      }
      // has some errors
      const { message: stderr } = result.reason as CompilerError;
      const [command, , ...messages] = stderr.split("\n");
      try {
        const items: CompileErrorItem[] = JSON.parse(messages.join("\n"));
        return {
          entryConfigPath: result.entryConfigPath,
          command,
          items
        };
      } catch {
        // for invalid compiler options errors
        throw new Error(`Unexpected non-JSON error: ${stderr}`);
      }
    })
    .filter(result => result.items.length > 0);
  if (results.filter(result => result.isRejected).length > 0) {
    throw new BuildJsCompilationError(reasons, results.length);
  }
  return reasons;

  function deleteLogUrl(input: string[]) {
    const messages = [...input];
    const lastIndex = messages.length - 1;
    let message = messages[lastIndex];
    if (message.startsWith(":")) {
      message = message.substring(1).trim();

      try {
        new URL(message); // check valid URL
        messages.splice(lastIndex, 1); // delete logUrl
      } catch (e) {
        // do nothing
      }
    }
    return messages;
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
  return files.filter(file => /\.json$/.test(file));
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
