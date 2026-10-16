import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  STDIO_DEFAULT_MAX_BUFFER_SIZE,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import {
  RECORDED_MCP_CATALOG_SHA256,
  type RecordedMcpCatalog,
} from "../recordedMcpCatalog.js";
import type { AppConfig } from "../config/types.js";
import { DeferredEvidenceMcpServer } from "../server/DeferredEvidenceMcpServer.js";
import { ToolResultDelivery } from "../server/ToolResultDelivery.js";
import { createLogger } from "../logger.js";
import { reportMcpShutdownFailure } from "./shutdown.js";
import type { RuntimeDependencies } from "./types.js";
import { MCP_CONNECTION_LOST, SERVER_START_FAILED } from "./messages.js";

/** Verify the build-owned artifact before trusting its exact typed projection. */
const readCatalog = (): RecordedMcpCatalog => {
  const bytes = readFileSync(new URL("../mcp-catalog.json", import.meta.url));
  if (
    createHash("sha256").update(bytes).digest("hex") !==
    RECORDED_MCP_CATALOG_SHA256
  )
    throw new Error(SERVER_START_FAILED);
  // The digest binds these bytes to the same compiled producer and SDK converter.
  const catalog: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    typeof catalog !== "object" ||
    catalog === null ||
    Reflect.get(catalog, "version") !== 1
  )
    throw new Error(SERVER_START_FAILED);
  return catalog as RecordedMcpCatalog;
};

const initializeRuntime = async (
  server: DeferredEvidenceMcpServer,
  dependencies: RuntimeDependencies,
  context: McpRequestContext,
  config: AppConfig,
  startedAt: string,
): Promise<void> => {
  let shutdown: (() => Promise<void>) | undefined;
  let closeSession: (() => Promise<void>) | undefined;
  let sessionClosed = false;
  server.ownRuntimeCleanup(async () => {
    if (shutdown !== undefined) return shutdown();
    const results = await Promise.allSettled([
      server.closePartialRuntime(),
      (async () => {
        if (!sessionClosed && closeSession !== undefined) {
          await closeSession();
          sessionClosed = true;
        }
      })(),
    ]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(failures, "MCP startup cleanup failed");
  });
  const [{ runEager }, { createServer }] = await Promise.all([
    import("./eagerRuntime.js"),
    import("../server/createServer.js"),
  ]);
  const result = await runEager(
    {
      ...dependencies,
      registerShutdown: () => () => undefined,
      captureShutdown: (close) => {
        shutdown = close;
      },
      createServer: (source, options) => {
        if (source.kind === "session")
          closeSession = async () => {
            const result = await source.session.close({
              retainProviderDocuments: true,
            });
            if (!result.ok) throw result.error;
          };
        return createServer(source, {
          ...options,
          mcpServer: server,
          startedAt,
        });
      },
      serve: (factory) => {
        let close: (() => Promise<void>) | undefined;
        server.materialize(() => {
          const configured = factory(context);
          if (configured !== server) throw new Error(SERVER_START_FAILED);
          close = configured.close.bind(configured);
        });
        return { close: () => close?.() ?? Promise.resolve() };
      },
    },
    config,
  );
  if (result !== 0 || shutdown === undefined)
    throw new Error(SERVER_START_FAILED);
};

/** Own every SDK-created server, including discarded discovery instances. */
export const runDeferred = async (
  dependencies: RuntimeDependencies,
  config: AppConfig,
): Promise<number> => {
  const serverLogger = createLogger("mcp", config.logLevel).child({
    layer: "server",
  });
  let firstCatalog: RecordedMcpCatalog | undefined = readCatalog();
  const servers = new Map<DeferredEvidenceMcpServer, () => Promise<void>>();
  let handle: StdioServerHandle | undefined;
  let attempt: Promise<void> | undefined;
  let unregister: () => void = () => undefined;
  const close = (): Promise<void> => {
    attempt ??= Promise.resolve()
      .then(async () => {
        const results = await Promise.allSettled([
          ...(handle === undefined ? [] : [handle.close()]),
          ...[...servers.values()].map((stop) => stop()),
        ]);
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length > 0)
          throw new AggregateError(failures, "MCP cleanup failed");
        unregister();
      })
      .catch((cause) => {
        attempt = undefined;
        throw cause;
      });
    return attempt;
  };
  const requestClose = () => {
    void close().catch((cause) =>
      reportMcpShutdownFailure(cause, dependencies, serverLogger),
    );
  };
  try {
    handle = dependencies.serve(
      (context) => {
        const catalog = firstCatalog ?? readCatalog();
        firstCatalog = undefined;
        const startedAt = new Date().toISOString();
        const server = new DeferredEvidenceMcpServer(
          catalog,
          new ToolResultDelivery(
            config.mcpMaxResponseBytes ?? STDIO_DEFAULT_MAX_BUFFER_SIZE,
          ),
          (target) =>
            initializeRuntime(
              target,
              dependencies,
              context,
              config,
              startedAt,
            ).catch((cause) => {
              dependencies.setExitCode(1);
              throw cause;
            }),
        );
        const stop = server.close.bind(server);
        const ownedClose = async () => {
          await stop();
          servers.delete(server);
        };
        servers.set(server, ownedClose);
        server.close = ownedClose;
        const previous = server.server.onclose;
        server.server.onclose = () => {
          previous?.();
          requestClose();
        };
        return server;
      },
      {
        onerror: () => {
          serverLogger.error(MCP_CONNECTION_LOST);
          dependencies.writeStderr(`${MCP_CONNECTION_LOST}\n`);
        },
      },
    );
    unregister = dependencies.registerShutdown(requestClose);
    dependencies.captureShutdown?.(close);
    return 0;
  } catch {
    await close();
    dependencies.writeStderr(`${SERVER_START_FAILED}\n`);
    return 1;
  }
};
