import { expect } from "vitest";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { createPackageWithOptions } from "@electron/asar";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

const cases = [
  {
    directory: "absolute-runtime",
    expression: '"/outside%2Fname.cjs"',
    target: null,
    status: "unavailable",
  },
  {
    directory: "literal",
    expression: 'path.join(__dirname, "preload%2F%5C%2E.cjs")',
    target: "preload%2F%5C%2E.cjs",
    status: "resolved",
  },
  {
    directory: "converted",
    expression:
      'fileURLToPath(new URL("./preload%252Fname.cjs", import.meta.url))',
    target: "preload%2Fname.cjs",
    status: "resolved",
  },
  {
    directory: "escaped",
    expression: 'path.join(__dirname, "../../outside%2Fname.cjs")',
    target: null,
    status: "rejected",
  },
  {
    directory: "ignored-prefix",
    expression:
      'path.resolve(new URL("./", import.meta.url), path.dirname(fileURLToPath(import.meta.url)), "preload%2Fname.cjs")',
    target: "preload%2Fname.cjs",
    status: "resolved",
  },
] as const;

const writeRuntimeFixture = async (root: string): Promise<void> => {
  const inert = 'throw new Error("fixture source must never execute");';
  const loadFileSource = `const { BrowserWindow } = require("electron");
      const win = new BrowserWindow();
      win.loadFile("dist%2Findex.html");
      win.loadFile("plain.html");
      win.loadFile("absent.html");`;
  await writeFixtureFiles(root, {
    "package.json": JSON.stringify({ private: true, workspaces: ["app"] }),
    ...Object.fromEntries(
      cases.map(({ directory, expression }) => [
        `${directory}/main.mjs`,
        `import { BrowserWindow, utilityProcess } from "electron";
         import path from "node:path";
         import { fileURLToPath } from "node:url";
         new BrowserWindow({ webPreferences: { preload: ${expression} } });
         utilityProcess.fork(${expression});`,
      ]),
    ),
    "literal/preload%2F%5C%2E.cjs": inert,
    "converted/preload%2Fname.cjs": inert,
    "converted/preload%252Fname.cjs": inert,
    "converted/preload/name.cjs": inert,
    "outside%2Fname.cjs": inert,
    "ignored-prefix/preload%2Fname.cjs": inert,
    "sub/main.cjs": loadFileSource,
    "dist%2Findex.html": "application target",
    "plain.html": "application target",
    "sub/dist%2Findex.html": "nested decoy",
    "sub/plain.html": "nested decoy",
    "sub/absent.html": "nested-only decoy",
    "app/package.json": JSON.stringify({ main: "sub/main.cjs" }),
    "app/sub/package.json": JSON.stringify({ type: "commonjs" }),
    "app/sub/main.cjs": loadFileSource,
    "app/dist%2Findex.html": "wrapped application target",
    "app/plain.html": "wrapped application target",
    "app/sub/dist%2Findex.html": "wrapped source decoy",
    "app/sub/plain.html": "wrapped source decoy",
    "app/sub/absent.html": "wrapped missing-target decoy",
    "external-app/package.json": JSON.stringify({ main: "../shared/main.cjs" }),
    "shared/main.cjs": loadFileSource,
    "external-app/dist%2Findex.html": "external-main application target",
    "external-app/plain.html": "external-main application target",
    "competition/package.json": JSON.stringify({ main: "main.cjs" }),
    "competition/main.cjs": 'require("./bridge.cjs");',
    "competition/bridge.cjs": 'require("./nested/main.cjs");',
    "competition/nested/package.json": JSON.stringify({ main: "main.cjs" }),
    "competition/nested/main.cjs": `${loadFileSource}\nrequire("../main.cjs");`,
    "competition/dist%2Findex.html": "running application page",
    "competition/nested/dist%2Findex.html": "competing application page",
    "import-owner/package.json": JSON.stringify({
      main: "../imported/start.cjs",
    }),
    "imported/start.cjs": 'require("./child.cjs");',
    "imported/child.cjs": loadFileSource,
    "import-owner/dist%2Findex.html": "imported application target",
    "import-owner/plain.html": "imported application target",
    "default-app/package.json": JSON.stringify({ name: "default-entry-app" }),
    "default-app/index.js": `${loadFileSource}\nrequire("./nested/main.cjs");`,
    "default-app/nested/package.json": JSON.stringify({ main: "main.cjs" }),
    "default-app/nested/main.cjs": loadFileSource,
    "default-app/nested/dist%2Findex.html": "competing default-entry page",
    "default-app/dist%2Findex.html": "default-entry application target",
    "default-app/plain.html": "default-entry application target",
    "ambiguous/package.json": JSON.stringify({ main: "sub/main.cjs" }),
    "ambiguous/sub/package.json": JSON.stringify({ main: "main.cjs" }),
    "ambiguous/third/package.json": JSON.stringify({ main: "../sub/main.cjs" }),
    "ambiguous/sub/main.cjs": loadFileSource,
    "ambiguous/dist%2Findex.html": "unproven application target",
    "ambiguous/sub/dist%2Findex.html": "unproven nested application target",
  });
  const archiveSource = await createTestTempDirectory("rea-loadfile-asar-");
  await writeFixtureFiles(archiveSource, {
    "package.json": JSON.stringify({ main: "sub/main.cjs" }),
    "sub/package.json": JSON.stringify({ type: "commonjs" }),
    "sub/main.cjs": loadFileSource,
    "dist%2Findex.html": "application target",
    "plain.html": "application target",
    "sub/dist%2Findex.html": "nested decoy",
    "sub/plain.html": "nested decoy",
    "sub/absent.html": "nested-only decoy",
    "external-app/package.json": JSON.stringify({ main: "../shared/main.cjs" }),
    "shared/main.cjs": loadFileSource,
    "external-app/dist%2Findex.html": "external-main application target",
    "external-app/plain.html": "external-main application target",
  });
  await createPackageWithOptions(archiveSource, join(root, "a.asar"), {});
  // Equal container digests must not select the other archive occurrence.
  await copyFile(join(root, "a.asar"), join(root, "b.asar"));
};

cliTest.for(["CLI", "stdio MCP"] as const)(
  "keeps invalid main declarations distinct from default entries through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-invalid-main-owner-");
    for (const [index, main] of [123, false, null, {}, []].entries()) {
      await writeFixtureFiles(root, {
        [`a${index}/package.json`]: JSON.stringify({
          name: `invalid-${index}`,
          main,
        }),
        [`a${index}/index.js`]: `require("../shared/window${index}.cjs");`,
        [`shared/window${index}.cjs`]:
          'const { BrowserWindow } = require("electron"); const win = new BrowserWindow(); win.loadFile("index.html");',
        [`a${index}/index.html`]: "invalid launch-owner decoy",
        "index.html": "artifact root decoy",
      });
    }
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const packages = graph.nodes.filter(({ kind }) => kind === "package");
    expect(packages).toHaveLength(5);
    for (const node of packages)
      expect(node.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              main: null,
              main_status: "invalid",
              parse_status: "included",
              name: expect.stringMatching(/^invalid-\d$/u),
            }),
          }),
        ]),
      );
    const roles = graph.nodes.filter(
      ({ kind }) => kind === "electron-renderer",
    );
    expect(roles).toHaveLength(5);
    for (const role of roles) {
      expect(role.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              resolved_path: null,
              resolution_status: "unavailable",
            }),
          }),
        ]),
      );
      expect(
        graph.edges.filter(
          ({ source_node_id, relation }) =>
            source_node_id === role.node_id && relation === "maps_to",
        ),
      ).toEqual([]);
    }
  },
);

cliTest.for(
  (["CLI", "stdio MCP"] as const).flatMap((surface) => [
    { surface, source: "app/sub/main.cjs", selectedOwner: false },
    { surface, source: "shared/main.cjs", selectedOwner: false },
    { surface, source: "shared/main.cjs", selectedOwner: true },
  ]),
)(
  "keeps unselected package ownership unknown through $surface for $source (selected owner: $selectedOwner)",
  async ({ surface, source, selectedOwner }, { cli }) => {
    const root = await createTestTempDirectory("rea-selected-loadfile-");
    await writeRuntimeFixture(root);
    if (selectedOwner)
      await writeFixtureFiles(root, {
        "other-owner/package.json": JSON.stringify({
          main: "../shared/main.cjs",
        }),
        "other-owner/dist%2Findex.html": "unselected competing page",
      });
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root, [
      "package.json",
      ...(selectedOwner ? ["external-app/package.json"] : []),
      source,
    ]);
    const roles = graph.nodes.filter(
      ({ kind, observations }) =>
        kind === "electron-renderer" &&
        observations.some(
          ({ properties }) =>
            properties.runtime_path_base === "application-root",
        ),
    );
    expect(roles).toHaveLength(3);
    for (const role of roles) {
      expect(role.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              resolved_path: null,
              resolution_status: "unavailable",
            }),
          }),
        ]),
      );
      expect(
        graph.edges.filter(
          ({ source_node_id, relation }) =>
            source_node_id === role.node_id && relation === "maps_to",
        ),
      ).toEqual([]);
    }
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "keeps omitted manifests in an identical ASAR occurrence separate through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-selected-asar-owner-");
    await writeRuntimeFixture(root);
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root, [
      "a.asar/package.json",
      "a.asar/sub/package.json",
      "a.asar/external-app/package.json",
      "a.asar/sub/main.cjs",
      "a.asar/shared/main.cjs",
    ]);
    const roles = graph.nodes.filter(
      ({ kind }) => kind === "electron-renderer",
    );
    expect(roles).toHaveLength(6);
    for (const role of roles) {
      const externalOwner = role.observations.some(
        ({ evidence }) =>
          evidence.location.available &&
          evidence.location.value.kind === "source-range" &&
          evidence.location.value.source === "a.asar/shared/main.cjs",
      );
      const declaration = role.observations.find(
        ({ properties }) => properties.runtime_path_base === "application-root",
      )?.properties.declared_path;
      const expected =
        declaration === "absent.html"
          ? null
          : `a.asar/${externalOwner ? "external-app/" : ""}${String(declaration)}`;
      expect(role.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              resolved_path: expected,
              resolution_status: expected === null ? "not-found" : "resolved",
            }),
          }),
        ]),
      );
      expect(
        graph.edges
          .filter(
            ({ source_node_id, relation }) =>
              source_node_id === role.node_id && relation === "maps_to",
          )
          .map(({ properties }) => properties.resolved_path),
      ).toEqual(expected === null ? [] : [expected]);
    }
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "keeps absolute loadFile host paths unknown through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-loadfile-absolute-");
    await writeFixtureFiles(root, {
      "app/package.json": JSON.stringify({ main: "main.cjs" }),
      "app/main.cjs":
        'const { BrowserWindow } = require("electron"); new BrowserWindow().loadFile("/dist/index.html");',
      "app/dist/index.html": "application-relative decoy",
      "dist/index.html": "artifact-root decoy",
    });
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const roles = graph.nodes.filter(
      ({ kind }) => kind === "electron-renderer",
    );
    expect(roles).toHaveLength(1);
    const role = roles[0];
    if (role === undefined) throw new Error("Missing renderer declaration");
    expect(role.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            declared_path: "/dist/index.html",
            resolved_path: null,
            resolution_status: "unavailable",
          }),
        }),
      ]),
    );
    expect(
      graph.edges.filter(
        ({ source_node_id, relation }) =>
          source_node_id === role.node_id && relation === "maps_to",
      ),
    ).toEqual([]);
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "preserves literal-percent runtime paths through %s without executing source",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-runtime-percent-");
    await writeRuntimeFixture(root);
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    for (const [sourcePath, targetRoot, declared] of (
      [
        ["sub/main.cjs", ""],
        ["app/sub/main.cjs", "app/"],
        ["shared/main.cjs", "external-app/"],
        ["default-app/index.js", "default-app/"],
        ["default-app/nested/main.cjs", null],
        ["ambiguous/sub/main.cjs", null],
        ["competition/nested/main.cjs", null],
        ["imported/child.cjs", "import-owner/"],
        ["a.asar/sub/main.cjs", "a.asar/"],
        ["b.asar/sub/main.cjs", "b.asar/"],
        ["a.asar/shared/main.cjs", "a.asar/external-app/"],
        ["b.asar/shared/main.cjs", "b.asar/external-app/"],
      ] as const
    ).flatMap(([sourcePath, targetRoot]) =>
      ["dist%2Findex.html", "plain.html", "absent.html"].map(
        (declared) => [sourcePath, targetRoot, declared] as const,
      ),
    )) {
      const role = graph.nodes.find(
        ({ kind, observations }) =>
          kind === "electron-renderer" &&
          observations.some(
            ({ properties, evidence }) =>
              properties.declared_path === declared &&
              evidence.location.available &&
              evidence.location.value.kind === "source-range" &&
              evidence.location.value.source === sourcePath,
          ),
      );
      expect(role).toBeDefined();
      if (role === undefined) throw new Error(`Missing loadFile ${declared}`);
      const expected =
        declared === "absent.html" || targetRoot === null
          ? null
          : `${targetRoot}${declared}`;
      expect(role.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              declared_path: declared,
              runtime_path_base: "application-root",
              resolved_path: expected,
              resolution_status:
                targetRoot === null
                  ? "unavailable"
                  : expected === null
                    ? "not-found"
                    : "resolved",
            }),
          }),
        ]),
      );
      expect(
        graph.edges
          .filter(
            ({ relation, source_node_id }) =>
              relation === "maps_to" && source_node_id === role.node_id,
          )
          .map(({ properties }) => properties.resolved_path),
      ).toEqual(expected === null ? [] : [expected]);
    }
    for (const { directory, target, status } of cases) {
      for (const kind of ["electron-preload", "electron-utility"] as const) {
        const nodes = graph.nodes.filter(
          ({ kind: nodeKind, observations }) =>
            nodeKind === kind &&
            observations.some(
              ({ evidence }) =>
                evidence.location.available &&
                evidence.location.value.kind === "source-range" &&
                evidence.location.value.source === `${directory}/main.mjs`,
            ),
        );
        expect(nodes).toHaveLength(1);
        const node = nodes[0];
        if (node === undefined) throw new Error(`Missing ${directory} ${kind}`);
        const resolutions = node.observations.filter(
          ({ properties }) => "resolution_status" in properties,
        );
        expect(resolutions).not.toHaveLength(0);
        for (const { properties } of resolutions) {
          expect(properties).toMatchObject({
            resolved_path: target === null ? null : `${directory}/${target}`,
            resolution_status: status,
          });
        }
        const mappedPaths = graph.edges
          .filter(
            ({ relation, source_node_id }) =>
              relation === "maps_to" && source_node_id === node.node_id,
          )
          .map(({ properties }) => properties.resolved_path);
        expect([...new Set(mappedPaths)]).toEqual(
          target === null ? [] : [`${directory}/${target}`],
        );
      }
    }
  },
);
