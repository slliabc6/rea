import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { GENERATED_MCP_TOOL_CATALOG } from "../../fixtures/mcpToolCatalog.js";
import { PROMPT_CONTRACTS } from "../../../src/contracts/promptContracts.js";
import { evidenceSchema } from "../../../src/domain/evidence.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";

const connect = async (
  mode: "legacy" | "auto",
  environment: Record<string, string> = {},
  nodeArguments: readonly string[] = [],
) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...nodeArguments, resolve("scripts/rea.mjs"), "mcp"],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      REA_LOG_LEVEL: "silent",
      ...environment,
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (value) => {
    stderr += value;
  });
  const client = new Client(
    { name: "deferred-runtime-boundary", version: "1" },
    { versionNegotiation: { mode } },
  );
  onTestFinished(async () => {
    await client.close();
    await transport.close();
  });
  await client.connect(transport);
  return { client, stderr: () => stderr };
};

it.each([
  { name: "deferred", environment: {}, eager: false },
  {
    name: "compact eager",
    environment: { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" },
    eager: true,
  },
])(
  "loads compiled analysis at the intended phase for $name startup",
  async ({ environment, eager }) => {
    const directory = await createTestTempDirectory("rea-mcp-module-loads-");
    const log = join(directory, "loaded.jsonl");
    await writeFile(log, "");
    const modules = [
      "main/eagerRuntime.js",
      "server/createServer.js",
      "composition/binary.js",
      "contracts/toolContracts.js",
    ];
    const hook = `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from "node:module";
import { appendFileSync } from "node:fs";
const modules = ${JSON.stringify(modules)};
registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    const source = loaded.source?.toString() ?? "";
    const names = modules.filter((name) =>
      url.endsWith("/dist/" + name) || source.includes("//#region dist/" + name + "\\n"));
    if (url.endsWith("/scripts/rea.mjs")) names.push("entrypoint");
    for (const name of names)
      appendFileSync(${JSON.stringify(log)}, JSON.stringify(name) + "\\n");
    return loaded;
  },
});
`)}`;
    const loadedModules = async () =>
      new Set(
        (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line): unknown => JSON.parse(line)),
      );
    const { client, stderr } = await connect("legacy", environment, [
      `--import=${hook}`,
    ]);
    await client.listTools();
    await client.listPrompts();
    expect(await loadedModules()).toEqual(
      new Set(eager ? ["entrypoint", ...modules] : ["entrypoint"]),
    );
    const result = await client.callTool({
      name: "list_unknowns",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    expect(await loadedModules()).toEqual(new Set(["entrypoint", ...modules]));
    expect(stderr()).toBe("");
  },
);

it.each(["legacy", "auto"] as const)(
  "serves the compiled discovery and canonical handlers over %s negotiation",
  async (mode) => {
    const recorded = JSON.parse(
      await readFile("dist/mcp-catalog.json", "utf8"),
    );
    const { client, stderr } = await connect(mode);
    const before = await client.listTools();
    expect(before.tools).toEqual(recorded.tools);
    const contractProjection = (tool: {
      name: string;
      title?: string | undefined;
      description?: string | undefined;
      inputSchema: unknown;
      outputSchema?: unknown;
      annotations?: unknown;
    }) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    });
    expect(
      new Map(
        before.tools.map((tool) => [tool.name, contractProjection(tool)]),
      ),
    ).toEqual(
      new Map(
        GENERATED_MCP_TOOL_CATALOG.map((tool) => [
          tool.name,
          contractProjection(tool),
        ]),
      ),
    );
    expect((await client.listPrompts()).prompts).toEqual(
      PROMPT_CONTRACTS.map((prompt) => ({
        name: prompt.name,
        title: prompt.title,
        description: prompt.description,
        arguments: Object.entries(prompt.arguments).map(([name, argument]) => ({
          name,
          description: argument.description,
          required: argument.required,
        })),
      })),
    );

    expect((await client.listPrompts()).prompts).toEqual(
      recorded.prompts.map(
        ({ parameters: _parameters, ...prompt }: Record<string, unknown>) =>
          prompt,
      ),
    );
    const results = await Promise.all([
      client.callTool({ name: "list_unknowns", arguments: {} }),
      client.callTool({ name: "list_unknowns", arguments: { limit: 1 } }),
    ]);
    expect(results.every((result) => result.isError !== true)).toBe(true);
    expect(results[0]?.structuredContent).toEqual({
      result: { items: [], total: 0, offset: 0, next_offset: null },
    });
    expect(await client.listTools()).toEqual(before);
    const invalid = await client.callTool({
      name: "list_unknowns",
      arguments: { limit: 1.5 },
    });
    expect(invalid.isError).toBe(true);
    expect(invalid._meta?.provenance).toEqual({
      untrusted_content: true,
      source: "analysis_target",
    });
    expect(client.getProtocolEra()).toBe(mode === "auto" ? "modern" : "legacy");
    if (mode === "auto")
      expect(invalid._meta?.["io.modelcontextprotocol/serverInfo"]).toEqual(
        recorded.info,
      );
    expect(stderr()).toBe("");
  },
);

it("preserves connection creation time across deferred materialization", async () => {
  const directory = await createTestTempDirectory("rea-mcp-started-at-");
  const clock = join(directory, "clock");
  const startedAt = "2020-01-01T00:00:00.000Z";
  await writeFile(clock, startedAt);
  const hook = `data:text/javascript,${encodeURIComponent(`
import { readFileSync } from "node:fs";
const NativeDate = Date;
globalThis.Date = class extends NativeDate {
  constructor(...args) {
    super(...(args.length === 0 ? [readFileSync(${JSON.stringify(clock)}, "utf8")] : args));
  }
};
`)}`;
  const { client } = await connect("legacy", {}, [`--import=${hook}`]);
  await client.listTools();
  await writeFile(clock, "2021-01-01T00:00:00.000Z");
  const first = await client.callTool({
    name: "binary_session",
    arguments: {},
  });
  expect(first.isError).not.toBe(true);
  expect(first.structuredContent).toMatchObject({
    result: { server_identity: { server: { started_at: startedAt } } },
  });
  const again = await client.callTool({
    name: "binary_session",
    arguments: {},
  });
  expect(again.structuredContent).toMatchObject({
    result: { server_identity: { server: { started_at: startedAt } } },
  });
});

it.each([
  { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" },
  { REA_MCP_OUTPUT_SCHEMA_PROFILE: "off" },
])("preserves the configured catalog profile %j", async (environment) => {
  const { client } = await connect("legacy", environment);
  const before = await client.listTools();
  const catalog = JSON.parse(await readFile("dist/mcp-catalog.json", "utf8"));
  expect(before.tools).toHaveLength(catalog.tools.length);
  if (environment.REA_MCP_OUTPUT_SCHEMA_PROFILE === "off")
    expect(before.tools.every((tool) => tool.outputSchema === undefined)).toBe(
      true,
    );
  const result = await client.callTool({
    name: "list_unknowns",
    arguments: {},
  });
  expect(result.isError).not.toBe(true);
});

it("runs the real static artifact workflow after deferred initialization", async () => {
  const { client } = await connect("legacy");
  const opened = await client.callTool({
    name: "open_binary",
    arguments: { path: resolve("scripts/rea.mjs") },
  });
  expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
  const inspected = await client.callTool({
    name: "inspect_artifact",
    arguments: { detail: "summary" },
  });
  expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
  const evidence = evidenceSchema.parse(inspected.structuredContent);
  expect(evidence.operation).toBe("inspect_analysis_view");
  const view = analysisViewResultSchema.parse(evidence.normalized_result);
  expect(view.parent_operation).toBe("inspect_artifact");
  const retained = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: {
        kind: "retained-evidence",
        evidence_id: view.parent_evidence_id,
      },
      view: { kind: "summary" },
    },
  });
  expect(retained.isError, JSON.stringify(retained)).not.toBe(true);
  const closed = await client.callTool({ name: "close_binary", arguments: {} });
  expect(closed.isError, JSON.stringify(closed)).not.toBe(true);
});

const copyCompiledPackage = async (prefix: string): Promise<string> => {
  const directory = await createTestTempDirectory(prefix);
  await cp(resolve("dist"), join(directory, "dist"), { recursive: true });
  await mkdir(join(directory, "scripts"));
  await cp(resolve("scripts/rea.mjs"), join(directory, "scripts/rea.mjs"));
  await cp(resolve("package.json"), join(directory, "package.json"));
  await symlink(
    resolve("node_modules"),
    join(directory, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return directory;
};

it("records the canonical catalog without a host account or ambient configuration", async () => {
  const directory = await copyCompiledPackage("rea-catalog-without-account-");
  await cp(
    resolve("scripts/record-mcp-catalog.mjs"),
    join(directory, "scripts/record-mcp-catalog.mjs"),
  );
  const temporary = join(directory, "temporary");
  await mkdir(temporary);
  const hook = `data:text/javascript,${encodeURIComponent(`
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
os.userInfo = () => { throw new Error("Host account is unavailable"); };
syncBuiltinESMExports();
`)}`;
  const child = spawnSync(
    process.execPath,
    [`--import=${hook}`, join(directory, "scripts/record-mcp-catalog.mjs")],
    {
      cwd: directory,
      env: {
        ...process.env,
        HOME: join(directory, "ambient-home"),
        USERPROFILE: join(directory, "ambient-home"),
        TMPDIR: temporary,
        TMP: temporary,
        TEMP: temporary,
        REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
        REA_MCP_OUTPUT_SCHEMA_PROFILE: "off",
      },
      encoding: "utf8",
      timeout: 30000,
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toBe("");
  expect(child.stderr).toBe("");
  expect(await readFile(join(directory, "dist/mcp-catalog.json"), "utf8")).toBe(
    await readFile("dist/mcp-catalog.json", "utf8"),
  );
  expect(
    await readFile(join(directory, "dist/recordedMcpCatalog.js"), "utf8"),
  ).toBe(await readFile("dist/recordedMcpCatalog.js", "utf8"));
  expect(await readdir(temporary)).toEqual([]);
});

it.each([
  { failures: ["client"] },
  { failures: ["client", "server", "session"] },
])(
  "settles every recorder owner when cleanup fails for $failures",
  async ({ failures }) => {
    const directory = await copyCompiledPackage("rea-catalog-cleanup-");
    await cp(
      resolve("scripts/record-mcp-catalog.mjs"),
      join(directory, "scripts/record-mcp-catalog.mjs"),
    );
    const log = join(directory, "cleanup.jsonl");
    const temporary = join(directory, "temporary");
    await mkdir(temporary);
    // Fault injection tests recorder ownership, not provider or SDK behavior.
    const close = (owner: string) => `async () => {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(${JSON.stringify(log)}, JSON.stringify(${JSON.stringify(owner)}) + "\\n");
      if (${JSON.stringify(failures)}.includes(${JSON.stringify(owner)}))
        throw new Error(${JSON.stringify(`${owner} cleanup failed`)});
      return { ok: true };
    }`;
    const replacements = {
      "/dist/server/createServer.js": `export const createServer = () => ({ connect: async () => {}, close: ${close("server")} });`,
      "/dist/composition/binary.js": `export const createBinarySession = () => ({ close: ${close("session")} });`,
      "/dist/config/parseConfig.js":
        "export const parseConfig = () => ({ ok: true, value: {} });",
      "/dist/logger.js": "export const silentLogger = {};",
      "/dist/contracts/promptContracts.js":
        "export const PROMPT_CONTRACTS = [];",
    };
    const clientModule = `data:text/javascript,${encodeURIComponent(`
export class Client {
  async connect() {}
  async listTools() { return { tools: [] }; }
  async listPrompts() { return { prompts: [] }; }
  getServerVersion() {}
  getServerCapabilities() {}
  getInstructions() {}
  close = ${close("client")};
}
export const InMemoryTransport = { createLinkedPair: () => [null, null] };
`)}`;
    const hook = `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from "node:module";
const replacements = ${JSON.stringify(replacements)};
registerHooks({
  resolve(specifier, context, next) {
    return specifier === "@modelcontextprotocol/client"
      ? { url: ${JSON.stringify(clientModule)}, shortCircuit: true }
      : next(specifier, context);
  },
  load(url, context, next) {
    const replacement = Object.entries(replacements).find(([path]) => url.endsWith(path));
    return replacement === undefined ? next(url, context)
      : { source: replacement[1], format: "module", shortCircuit: true };
  },
});
`)}`;
    const child = spawnSync(
      process.execPath,
      [`--import=${hook}`, join(directory, "scripts/record-mcp-catalog.mjs")],
      {
        cwd: directory,
        env: {
          ...process.env,
          TMPDIR: temporary,
          TMP: temporary,
          TEMP: temporary,
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(
      new Set(
        (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line): unknown => JSON.parse(line)),
      ),
    ).toEqual(new Set(["client", "server", "session"]));
    for (const owner of failures)
      expect(child.stderr).toContain(`${owner} cleanup failed`);
    expect(child.stderr).toContain("AggregateError: Catalog cleanup failed");
    expect(await readdir(temporary)).toHaveLength(1);
  },
);

it("rejects a corrupted build-owned catalog before starting the connection", async () => {
  const directory = await copyCompiledPackage("rea-corrupted-mcp-catalog-");
  await writeFile(join(directory, "dist/mcp-catalog.json"), "{}");
  const child = spawnSync(
    process.execPath,
    [join(directory, "scripts/rea.mjs"), "mcp"],
    { cwd: directory, input: "", encoding: "utf8", timeout: 10000 },
  );
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(1);
  expect(child.stdout).toBe("");
  expect(child.stderr).toBe(
    "REA could not start. Run `rea doctor`, then restart REA from your MCP client.\n",
  );
});
