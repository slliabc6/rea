#!/usr/bin/env node

import { snapshotEnvironment } from "./process/snapshotEnvironment.js";
import { CURRENT_ENTRYPOINT_PATH } from "./process/CurrentEntrypointPath.js";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { parseConfig } from "./config/parseConfig.js";
import { projectAnalysisError } from "./domain/analysisErrorProjection.js";
import type { RuntimeDependencies } from "./main/types.js";
import { runDeferred } from "./main/deferredRuntime.js";
import { RECORDED_MCP_CATALOG_SHA256 } from "./recordedMcpCatalog.js";
import { SERVER_START_FAILED } from "./main/messages.js";

import { registerProcessShutdown } from "./main/processShutdown.js";

const runtimeDependencies = (): RuntimeDependencies => ({
  env: process.env,
  serve: serveStdio,
  writeStderr: (text) => process.stderr.write(text),
  setExitCode: (code) => {
    process.exitCode = code;
  },
  registerShutdown: registerProcessShutdown,
});

/** Start discovery without constructing unused analysis validators. */
export const run = async (
  dependencies: RuntimeDependencies = runtimeDependencies(),
): Promise<number> => {
  const environment = snapshotEnvironment(dependencies.env);
  const config = parseConfig(environment);
  if (!config.ok) {
    dependencies.writeStderr(`${projectAnalysisError(config.error).message}\n`);
    return 1;
  }
  const defaultCatalog =
    (environment.REA_MCP_INPUT_SCHEMA_PROFILE === undefined ||
      environment.REA_MCP_INPUT_SCHEMA_PROFILE === "full") &&
    (environment.REA_MCP_OUTPUT_SCHEMA_PROFILE === undefined ||
      environment.REA_MCP_OUTPUT_SCHEMA_PROFILE === "full");
  if (
    RECORDED_MCP_CATALOG_SHA256 !== undefined &&
    config.value.hopperTargetPath === undefined &&
    defaultCatalog &&
    dependencies.createServer === undefined &&
    dependencies.loadOptionalProviders === undefined
  ) {
    return runDeferred({ ...dependencies, env: environment }, config.value);
  }
  return (await import("./main/eagerRuntime.js")).runEager(
    { ...dependencies, env: environment },
    config.value,
  );
};

/** Run the executable boundary without exposing an unexpected startup cause. */
export const runEntrypoint = async (
  start: () => Promise<number> = () => run(),
  writeStderr: (text: string) => void = (text) => process.stderr.write(text),
  setExitCode: (code: number) => void = (code) => {
    process.exitCode = code;
  },
): Promise<void> => {
  try {
    setExitCode(await start());
  } catch (cause: unknown) {
    // Intentionally redact the startup cause from caller-visible output;
    // unexpected failures must not leak internal details.
    void cause;
    writeStderr(`${SERVER_START_FAILED}\n`);
    setExitCode(1);
  }
};

/** Return false when the runtime's argv path is synthetic or no longer exists. */
const isDirectEntrypoint = (
  entryPath: string | undefined,
  moduleUrl: string,
): boolean => {
  if (entryPath === undefined) return false;
  try {
    return pathToFileURL(realpathSync(entryPath)).href === moduleUrl;
  } catch {
    return false;
  }
};

if (isDirectEntrypoint(CURRENT_ENTRYPOINT_PATH, import.meta.url)) {
  void runEntrypoint();
}
