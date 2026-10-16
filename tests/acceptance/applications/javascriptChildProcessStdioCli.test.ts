import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

const cases = [
  ["duplicate", '{ stdio: "pipe", stdio: "inherit" }', "inherit"],
  ["explicit", '{ stdio: "inherit" }', "inherit"],
  ["spread-after", '{ stdio: "pipe", ...options }', "dynamic"],
  ["spread-before", '{ ...options, stdio: "inherit" }', "inherit"],
  ["null-spread", '{ stdio: "inherit", ...null }', "inherit"],
  ["undefined-spread", '{ stdio: "inherit", ...undefined }', "inherit"],
  ["void-spread", '{ stdio: "inherit", ...void 0 }', "inherit"],
  [
    "wrapped-null-spread",
    '{ stdio: "inherit", ...(null as unknown) }',
    "inherit",
  ],
  ["computed-after", '{ stdio: "pipe", [key]: "inherit" }', "dynamic"],
  ["computed-before", '{ [key]: "pipe", stdio: "inherit" }', "inherit"],
  ["computed-literal", '{ stdio: "pipe", ["stdio"]: "inherit" }', "inherit"],
  ["unrelated", '{ stdio: "inherit", cwd: "/unused", [0]: "x" }', "inherit"],
  ["empty-template", '{ stdio: "inherit", [``]: 1 }', "inherit"],
  ["empty-string", '{ stdio: "inherit", [""]: 1 }', "inherit"],
  ["boolean-key", '{ stdio: "inherit", [true]: 1 }', "inherit"],
  ["null-key", '{ stdio: "inherit", [null]: 1 }', "inherit"],
  ["negative-key", '{ stdio: "inherit", [-1]: 1 }', "inherit"],
  ["negative-zero-key", '{ stdio: "inherit", [-0]: 1 }', "inherit"],
  ["typed-key", '{ stdio: "inherit", [-(1 as number)]: 1 }', "inherit"],
  [
    "typed-boolean-key",
    '{ stdio: "inherit", [(true as boolean)]: 1 }',
    "inherit",
  ],
  ["call-key", '{ stdio: "inherit", [getKey()]: 1 }', "dynamic"],
  ["object-key", '{ stdio: "inherit", [{}]: 1 }', "dynamic"],
  [
    "typed-env",
    '({ stdio: "inherit", env: { MODE: "test" } } as const)',
    "inherit",
  ],
  ["getter", '{ stdio: "pipe", get stdio() { return "inherit"; } }', "dynamic"],
  ["method", '{ stdio: "pipe", stdio() {} }', "dynamic"],
  ["value", "{ stdio: mode }", "dynamic"],
  ["options", "options", "dynamic"],
  ["expression", "chooseOptions()", "dynamic"],
  ["array", '{ stdio: ["ignore", "pipe", "pipe"] }', "array"],
  ["empty", "{}", "default"],
  ["env", '{ env: { MODE: "test" } }', "default"],
  ["null", "null", "default"],
  ["undefined", "undefined", "default"],
  ["void", "void 0", "default"],
  ["stdio-null", "{ stdio: null }", "default"],
  ["stdio-undefined", "{ stdio: undefined }", "default"],
  ["stdio-void", "{ stdio: void 0 }", "default"],
] as const;

const spreadBindingFixture = `export function spreadBindings(incoming, flag) {
          let value = null;
          spawn("spread-before-replacement", [], { stdio: "inherit", ...value });
          const saved = value; value = incoming;
          spawn("spread-after-replacement", [], { stdio: "inherit", ...value });
          spawn("spread-captured", [], { stdio: "inherit", ...saved });
          value = null;
          spawn("spread-reinitialized", [], { stdio: "inherit", ...value });
          spawn("spread-before-initialization", [], { stdio: "inherit", ...future });
          const future = null;
          const empty = undefined;
          spawn("spread-undefined-alias", [], { stdio: "inherit", ...empty });
          const alternatives = flag ? null : void 0;
          spawn("spread-nullish-branches", [], { stdio: "inherit", ...alternatives });
          const mixed = flag ? null : incoming;
          spawn("spread-unknown-branch", [], { stdio: "inherit", ...mixed });
          let partial; if(flag) partial = null;
          spawn("spread-partial", [], { stdio: "inherit", ...partial });
        }`;

const spreadBindingModes = [
  ["before-replacement", "inherit"],
  ["captured", "inherit"],
  ["reinitialized", "inherit"],
  ["undefined-alias", "inherit"],
  ["nullish-branches", "inherit"],
  ["after-replacement", "dynamic"],
  ["before-initialization", "dynamic"],
  ["unknown-branch", "dynamic"],
  ["partial", "dynamic"],
] as const;

cliTest.for(["CLI", "stdio MCP"] as const)(
  "preserves effective child-process stdio and uncertainty through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-child-stdio-");
    const expected = new Map<string, string>();
    const wrappedArgv = new Set<string>();
    const calls: string[] = [];
    for (const method of ["spawn", "exec", "execFile", "fork"] as const) {
      for (const [name, options, mode] of cases) {
        const command = `${method}-${name}`;
        expected.set(command, mode);
        calls.push(
          `${method}("${command}", ${method === "exec" ? "" : "[], "}${options});`,
        );
      }
      expected.set(`${method}-omitted`, "default");
      calls.push(`${method}("${method}-omitted");`);
      expected.set(`${method}-options-only`, "dynamic");
      calls.push(`${method}("${method}-options-only", options);`);
    }
    for (const method of ["spawn", "execFile", "fork"] as const) {
      for (const value of ["null", "undefined", "void 0", '"pipe"']) {
        const command = `${method}-ambiguous-${value}`;
        expected.set(command, "dynamic");
        calls.push(
          `${method}(${JSON.stringify(command)}, options, { stdio: ${value} });`,
        );
      }
      for (const [name, argv] of [
        ["as", "[] as string[]"],
        ["satisfies", "[] satisfies string[]"],
        ["non-null", "[]!"],
        ["nested", "([] as string[])!"],
      ] as const) {
        for (const [suffix, options, mode] of [
          ["omitted", "", "default"],
          ["explicit", ', { stdio: "inherit" }', "inherit"],
        ] as const) {
          const command = `${method}-argv-${name}-${suffix}`;
          expected.set(command, mode);
          wrappedArgv.add(command);
          calls.push(`${method}("${command}", ${argv}${options});`);
        }
      }
      for (const second of ["null", "undefined", "void 0"]) {
        const command = `${method}-nullish-${second}`;
        expected.set(command, "inherit");
        calls.push(`${method}("${command}", ${second}, { stdio: "inherit" });`);
      }
      const command = `${method}-second-object`;
      expected.set(command, "inherit");
      calls.push(
        `${method}("${command}", ({ stdio: "inherit" } as const), { stdio: null });`,
      );
    }
    for (const call of [
      'exec("exec-callback", () => {});',
      'execFile("execFile-callback", [], () => {});',
      'execFile("execFile-options-callback", { stdio: "inherit" }, () => {});',
      'execFile("execFile-unknown-callback", options, () => {});',
      'spawn("spawn-options-final", { stdio: "pipe", stdio: "inherit" });',
      'execFile("typed-callback", (() => {}) as () => void, { stdio: "inherit" });',
    ]) {
      calls.push(call);
    }
    expected.set("exec-callback", "default");
    expected.set("execFile-callback", "default");
    expected.set("execFile-options-callback", "inherit");
    expected.set("execFile-unknown-callback", "dynamic");
    expected.set("spawn-options-final", "inherit");
    expected.set("typed-callback", "default");
    await writeFixtureFiles(root, {
      "entry.ts": [
        'import { spawn, exec, execFile, fork } from "node:child_process";',
        'throw new Error("static fixture must never execute");',
        "export function run(options, key, mode) {",
        ...calls,
        "}",
        'export function shadowed(undefined) { spawn("shadowed-undefined", [], undefined); spawn("shadowed-undefined-third", undefined, { stdio: null }); }',
        'export function shadowedSpread(undefined) { spawn("shadowed-spread", [], { stdio: "inherit", ...undefined }); }',
        'export function localUndefinedSpread() { const undefined = { stdio: "pipe" }; spawn("local-undefined-spread", [], { stdio: "inherit", ...undefined }); }',
        'const absent = null; const noOptions = absent; spawn("null-alias-spread", [], { stdio: "inherit", ...noOptions });',
        spreadBindingFixture,
      ].join("\n"),
    });
    expected.set("shadowed-undefined", "dynamic");
    expected.set("shadowed-undefined-third", "dynamic");
    expected.set("shadowed-spread", "dynamic");
    expected.set("local-undefined-spread", "dynamic");
    expected.set("null-alias-spread", "inherit");
    for (const [name, mode] of spreadBindingModes)
      expected.set(`spread-${name}`, mode);
    const { semantic_graph: graph } = await analyzeJavaScriptDirectory(
      surface,
      cli,
      root,
    );
    const children = graph.nodes.filter(
      (node) => node.kind === "child-process",
    );
    expect(children).toHaveLength(expected.size);
    expect(
      children
        .map((child) => [child.properties.command, child.properties.stdio_mode])
        .sort(),
    ).toEqual([...expected].sort());
    for (const child of children) {
      const command = String(child.properties.command);
      const mode = expected.get(command);
      expect(mode, command).toBeDefined();
      const stdio = graph.relations.filter(
        (relation) =>
          relation.source_node_id === child.node_id &&
          relation.relation === "connects-stdio",
      );
      expect(stdio, command).toHaveLength(1);
      expect(
        graph.nodes.find((node) => node.node_id === stdio[0]?.target_node_id),
        command,
      ).toMatchObject({ kind: "stdio", properties: { mode } });
      expect(stdio[0]?.resolution, command).toBe(
        mode === "dynamic" ? "candidate" : "resolved",
      );
      const unknowns = graph.unknowns.filter(
        (unknown) =>
          unknown.family === "child-process" &&
          unknown.node_id === child.node_id &&
          unknown.relation_kinds.includes("connects-stdio"),
      );
      expect(unknowns.length, command).toBe(mode === "dynamic" ? 1 : 0);
      if (mode === "dynamic")
        expect(unknowns[0]).toMatchObject({ reason: "unknown-value" });
      expect(child.properties.environment_supplied, command).toBe(
        command.endsWith("-env"),
      );
      if (
        cases.some(([name]) => command === `spawn-${name}`) ||
        wrappedArgv.has(command)
      )
        expect(child.properties.argv_count, command).toBe(0);
    }
    expect(
      graph.coverage.families.find(({ family }) => family === "child-process"),
    ).toMatchObject({ status: "partial" });
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "proves local callback defaults at each child-process read through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-child-callback-");
    await writeFixtureFiles(root, {
      "entry.ts": `
        import { exec, execFile, spawn, fork } from "node:child_process";
        import { done as imported } from "./external.mjs";
        throw new Error("static fixture must never execute");
        function done() {}
        const arrow = () => {};
        const alias = done;
        class NotCallback {}
        exec("declaration", done);
        exec("const", arrow);
        exec("alias", alias);
        exec("typed", (done as () => void)!);
        execFile("callback-second", done);
        execFile("argv-callback", [], alias);
        execFile("typed-argv-callback", [] as string[], arrow);
        exec("explicit-options", { stdio: "inherit" }, done);
        execFile("argv-options", [], { stdio: "inherit" }, done);
        spawn("spawn-function", [], done);
        fork("fork-function", [], alias);
        exec("imported", imported);
        exec("class", NotCallback);
        let changing = done;
        exec("before-replacement", changing);
        const saved = changing;
        changing = {};
        exec("after-replacement", changing);
        exec("captured-alias", saved);
        let later;
        exec("before-initialization", later);
        later = done;
        exec("after-initialization", later);
        {
          exec("before-const-initialization", future);
          const future = () => {};
        }
        export function run(options, flag) {
          exec("unknown", options);
          execFile("unknown-options", options, done);
          let partial;
          if (flag) partial = done;
          exec("partial", partial);
          const alternatives = flag ? done : arrow;
          exec("all-functions", alternatives);
          const mixed = flag ? done : NotCallback;
          exec("mixed-class", mixed);
          let replaced = done;
          replaced = options;
          exec("unknown-replacement", replaced);
          const projected = { done }.done;
          exec("projected", projected);
        }
        export function shadowed(done) { exec("shadowed", done); }
        let unordered;
        function initialize() { unordered = done; }
        export function use() { exec("unordered", unordered); }
      `,
      "external.mjs": "export function done() {}",
    });
    const expected = new Map([
      ...[
        "declaration",
        "const",
        "alias",
        "typed",
        "callback-second",
        "argv-callback",
        "typed-argv-callback",
        "before-replacement",
        "captured-alias",
        "after-initialization",
        "all-functions",
      ].map((command) => [command, "default"] as const),
      ...["explicit-options", "argv-options"].map(
        (command) => [command, "inherit"] as const,
      ),
      ...[
        "spawn-function",
        "fork-function",
        "imported",
        "class",
        "after-replacement",
        "before-initialization",
        "before-const-initialization",
        "unknown",
        "unknown-options",
        "partial",
        "mixed-class",
        "unknown-replacement",
        "projected",
        "shadowed",
        "unordered",
      ].map((command) => [command, "dynamic"] as const),
    ]);
    const { semantic_graph: graph } = await analyzeJavaScriptDirectory(
      surface,
      cli,
      root,
    );
    const children = graph.nodes.filter(
      (node) => node.kind === "child-process",
    );
    expect(children).toHaveLength(expected.size);
    for (const child of children) {
      const command = String(child.properties.command);
      const mode = expected.get(command);
      expect(mode, command).toBeDefined();
      expect(child.properties.stdio_mode, command).toBe(mode);
      const relations = graph.relations.filter(
        (relation) =>
          relation.source_node_id === child.node_id &&
          relation.relation === "connects-stdio",
      );
      expect(relations, command).toHaveLength(1);
      expect(relations[0]?.resolution, command).toBe(
        mode === "dynamic" ? "candidate" : "resolved",
      );
      expect(
        graph.nodes.find(
          (node) => node.node_id === relations[0]?.target_node_id,
        ),
        command,
      ).toMatchObject({ kind: "stdio", properties: { mode } });
      const unknowns = graph.unknowns.filter(
        (unknown) =>
          unknown.node_id === child.node_id &&
          unknown.family === "child-process" &&
          unknown.relation_kinds.includes("connects-stdio"),
      );
      expect(unknowns.length, command).toBe(mode === "dynamic" ? 1 : 0);
      if (mode === "dynamic")
        expect(unknowns[0]?.reason, command).toBe("unknown-value");
    }
    expect(graph.coverage.truncated).toBe(false);
  },
);
