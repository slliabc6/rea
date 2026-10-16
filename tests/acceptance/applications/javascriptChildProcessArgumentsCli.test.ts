import { join } from "node:path";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "keeps child argv counts unknown after spread through %s",
  async (surface, { cli, processes }) => {
    const root = await createTestTempDirectory("rea-child-argv-");
    await writeFixtureFiles(root, {
      "entry.mjs": [
        'import { spawn, execFile, fork } from "node:child_process";',
        'const args = ["a", "b"];',
        'spawn("spread-spawn", [...args]);',
        'execFile("spread-exec", ["prefix", ...args]);',
        'fork("spread-fork", [...args, "suffix"]);',
        'spawn("fixed", ["a", "b"]);',
        'execFile("empty", []);',
      ].join("\n"),
      "child.cjs": "console.log(process.argv.slice(2).length);",
    });
    const args = ["a", "b"];
    const counts: number[] = [];
    for (const values of [
      [...args],
      ["prefix", ...args],
      [...args, "suffix"],
      ["a", "b"],
      [],
    ]) {
      const control = await processes.run(
        process.execPath,
        [join(root, "child.cjs"), ...values],
        { timeoutMs: 5_000 },
      );
      expect(control.exitCode, control.stderr).toBe(0);
      counts.push(Number(control.stdout));
    }
    expect(counts).toEqual([2, 3, 3, 2, 0]);
    const graph = (await analyzeJavaScriptDirectory(surface, cli, root))
      .semantic_graph;
    const children = graph.nodes.filter(
      (node) => node.kind === "child-process",
    );
    expect(children).toHaveLength(5);
    for (const command of ["spread-spawn", "spread-exec", "spread-fork"]) {
      const child = children.find(
        (node) => node.properties.command === command,
      );
      expect(child?.properties.argv_count, command).toBeNull();
      expect(
        graph.relations.filter(
          (relation) =>
            relation.relation === "supplies-argv" &&
            relation.target_node_id === child?.node_id,
        ),
      ).toEqual([]);
    }
    expect(
      children.find((node) => node.properties.command === "fixed")?.properties
        .argv_count,
    ).toBe(2);
    expect(
      children.find((node) => node.properties.command === "empty")?.properties
        .argv_count,
    ).toBe(0);
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "keeps eval-exposed argv and undefined uncertain through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-child-eval-shapes-");
    await writeFixtureFiles(root, {
      "entry.cjs": `
      const {spawn} = require("node:child_process");
      throw new Error("static fixture must never execute");
      function globalEval() {
        let args = []; eval("args = {}");
        spawn("eval-argv", args, {env:{A:"1"},stdio:"inherit"});
        eval("var undefined = {stdio:'ignore'}");
        spawn("eval-spread", [], {stdio:"inherit", ...undefined});
        spawn("eval-undefined-slot", undefined, {env:{A:"1"},stdio:"inherit"});
        spawn("literal-array", [], {env:{A:"1"},stdio:"inherit"});
        spawn("literal-null", [], {stdio:"inherit", ...null});
      }
      function suppliedEval(eval) {
        let args=[]; eval("args = {}");
        spawn("supplied-eval-argv", args, {env:{A:"1"},stdio:"inherit"});
      }
    `,
    });
    const graph = (await analyzeJavaScriptDirectory(surface, cli, root))
      .semantic_graph;
    const children = graph.nodes.filter(
      (node) => node.kind === "child-process",
    );
    expect(children).toHaveLength(6);
    for (const child of children) {
      const command = String(child.properties.command);
      const literal = command.startsWith("literal-");
      expect(child.properties.stdio_mode, command).toBe(
        literal ? "inherit" : "dynamic",
      );
      expect(child.properties.environment_supplied, command).toBe(
        command === "literal-array",
      );
      expect(
        graph.relations.filter(
          (relation) =>
            relation.relation === "supplies-env" &&
            relation.target_node_id === child.node_id,
        ),
        command,
      ).toHaveLength(command === "literal-array" ? 1 : 0);
      const stdio = graph.relations.filter(
        (relation) =>
          relation.relation === "connects-stdio" &&
          relation.source_node_id === child.node_id,
      );
      expect(stdio, command).toHaveLength(1);
      expect(stdio[0]?.resolution, command).toBe(
        literal ? "resolved" : "candidate",
      );
      expect(
        graph.unknowns.filter(
          (unknown) =>
            unknown.family === "child-process" &&
            unknown.node_id === child.node_id &&
            unknown.relation_kinds.includes("connects-stdio"),
        ),
        command,
      ).toHaveLength(literal ? 0 : 1);
    }
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "selects child options from proven argv shapes at each read through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-child-argv-bindings-");
    const methods = ["spawn", "execFile", "fork"] as const;
    const expected = new Map<string, boolean>();
    const fixture: string[] = [
      'import { spawn, execFile, fork } from "node:child_process";',
      'throw new Error("static fixture must never execute");',
    ];
    for (const method of methods) {
      const call = (name: string, argv: string, known: boolean) => {
        const command = `${method}-${name}`;
        expected.set(command, known);
        return `${method}("${command}", ${argv}, { env: { A: "1" }, stdio: "inherit" });`;
      };
      fixture.push(
        `export function ${method}Cases(flag, incoming) {`,
        "const args = []; const alias = args;",
        call("named", "args", true),
        call("alias", "alias", true),
        call("wrapped", "(alias as string[])!", true),
        "const spreadArgs = [...incoming];",
        call("spread", "spreadArgs", true),
        "args.push('added'); args.length = incoming;",
        call("mutated", "args", true),
        "let changing = [];",
        call("before-replacement", "changing", true),
        "const saved = changing; changing = incoming;",
        call("after-replacement", "changing", false),
        call("captured", "saved", true),
        "changing = [];",
        call("reinitialized", "changing", true),
        call("before-initialization", "future", false),
        "const future = [];",
        call("after-initialization", "future", true),
        "let partial; if (flag) partial = [];",
        call("partial", "partial", false),
        "const alternatives = flag ? [] : [...incoming];",
        call("all-arrays", "alternatives", true),
        "const mixed = flag ? [] : {};",
        call("mixed", "mixed", false),
        "const unknownBranch = flag ? [] : incoming;",
        call("unknown-branch", "unknownBranch", false),
        "const projected = { args: [] }.args;",
        call("projected", "projected", false),
        "let later; const earlyAlias = later; later = [];",
        call("early-alias", "earlyAlias", false),
        call("later-initialized", "later", true),
        "}",
        `export function ${method}Shadow(args) {`,
        call("shadowed", "args", false),
        "}",
        `let ${method}Outer; function ${method}Initialize() { ${method}Outer = []; }`,
        `export function ${method}Unordered() {`,
        call("unordered", `${method}Outer`, false),
        "}",
      );
    }
    await writeFixtureFiles(root, { "entry.ts": fixture.join("\n") });
    const graph = (await analyzeJavaScriptDirectory(surface, cli, root))
      .semantic_graph;
    const children = graph.nodes.filter(
      (node) => node.kind === "child-process",
    );
    expect(children).toHaveLength(expected.size);
    for (const child of children) {
      const command = String(child.properties.command);
      const known = expected.get(command);
      expect(known, command).toBeDefined();
      expect(child.properties.stdio_mode, command).toBe(
        known ? "inherit" : "dynamic",
      );
      expect(child.properties.environment_supplied, command).toBe(known);
      // Array identity survives mutation; a binding's intrinsic length is not proved.
      expect(child.properties.argv_count, command).toBeNull();
      expect(
        graph.relations.filter(
          (relation) =>
            relation.relation === "supplies-argv" &&
            relation.target_node_id === child.node_id,
        ),
        command,
      ).toEqual([]);
      const environment = graph.relations.filter(
        (relation) =>
          relation.relation === "supplies-env" &&
          relation.target_node_id === child.node_id,
      );
      expect(environment, command).toHaveLength(known ? 1 : 0);
      if (known) expect(environment[0]?.resolution, command).toBe("resolved");
      const stdio = graph.relations.filter(
        (relation) =>
          relation.relation === "connects-stdio" &&
          relation.source_node_id === child.node_id,
      );
      expect(stdio, command).toHaveLength(1);
      expect(stdio[0]?.resolution, command).toBe(
        known ? "resolved" : "candidate",
      );
      expect(
        graph.nodes.find((node) => node.node_id === stdio[0]?.target_node_id),
        command,
      ).toMatchObject({
        kind: "stdio",
        properties: { mode: known ? "inherit" : "dynamic" },
      });
      const unknowns = graph.unknowns.filter(
        (unknown) =>
          unknown.node_id === child.node_id &&
          unknown.family === "child-process" &&
          unknown.relation_kinds.includes("connects-stdio"),
      );
      expect(unknowns, command).toHaveLength(known ? 0 : 1);
      if (!known) expect(unknowns[0]?.reason, command).toBe("unknown-value");
    }
    expect(graph.coverage.truncated).toBe(false);
  },
);
