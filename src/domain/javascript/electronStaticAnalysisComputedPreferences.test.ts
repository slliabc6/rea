import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

describe("computed Electron web preference keys", () => {
  it.each(["null", "undefined", "void 0", "(null as unknown)"])(
    "keeps preload and service after a no-op spread: %s",
    (spread) => {
      const analysis = analyzeJavaScriptStaticSource(`
        const { BrowserWindow, utilityProcess } = require("electron");
        new BrowserWindow({ webPreferences: { preload: "./kept.js", ...${spread} }, ...${spread} });
        utilityProcess.fork("./worker.js", [], { serviceName: "kept", ...${spread} });
      `);
      expect(analysis.electron.browser_windows[0]).toMatchObject({
        preload_path: "./kept.js",
        web_preferences_status: "object-literal",
      });
      expect(analysis.electron.utility_processes[0]?.service_name).toBe("kept");
    },
  );

  it("does not skip an undefined spread shadowed by an unknown parameter", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      const { BrowserWindow, utilityProcess } = require("electron");
      function run(undefined) {
        new BrowserWindow({ webPreferences: { preload: "./old.js", ...undefined } });
        utilityProcess.fork("./worker.js", [], { serviceName: "old", ...undefined });
      }
    `);
    expect(analysis.electron.browser_windows[0]?.preload_path).toBeNull();
    expect(analysis.electron.utility_processes[0]?.service_name).toBeNull();
  });

  it("uses captured nullish aliases without reusing a later unknown spread", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      const { BrowserWindow } = require("electron");
      function run(incoming) {
        let value = null; const saved = value; value = incoming;
        new BrowserWindow({ webPreferences: { preload: "./kept.js", ...saved } });
        new BrowserWindow({ webPreferences: { preload: "./unknown.js", ...value } });
      }
    `);
    expect(
      analysis.electron.browser_windows.map((window) => window.preload_path),
    ).toEqual(["./kept.js", null]);
  });

  it("retains exact string, numeric, and empty literal keys", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      const { BrowserWindow } = require("electron");
      new BrowserWindow({ webPreferences: {
        ["sandbox"]: true,
        ["preload"]: "./preload.js",
        [1]: "numeric",
        [""]: false
      } });
    `);

    expect(analysis.parse_status).toBe("complete");
    expect(analysis.electron.browser_windows[0]).toMatchObject({
      preload_path: "./preload.js",
      web_preferences: [
        { name: "", value: { status: "literal", value: false } },
        { name: "1", value: { status: "literal", value: "numeric" } },
        {
          name: "preload",
          value: { status: "literal", value: "./preload.js" },
        },
        { name: "sandbox", value: { status: "literal", value: true } },
      ],
    });
  });

  it("keeps genuinely dynamic computed keys unknown", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      const { BrowserWindow } = require("electron");
      new BrowserWindow({ webPreferences: {
        [getKey()]: true,
        ["sandbox"]: true
      } });
    `);

    expect(analysis.parse_status).toBe("partial");
    expect(analysis.electron.browser_windows[0]?.web_preferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: expect.stringMatching(/^\[dynamic@/u),
          value: expect.objectContaining({ status: "dynamic" }),
        }),
        {
          name: "sandbox",
          value: { status: "literal", value: true, expression: null },
        },
      ]),
    );
  });

  it("keeps preload and service identity after unrelated empty template keys", () => {
    const analysis = analyzeJavaScriptStaticSource(
      [
        'const { BrowserWindow, utilityProcess } = require("electron");',
        'new BrowserWindow({ webPreferences: { preload: "./kept.js", [``]: true }, [``]: null });',
        'utilityProcess.fork("./worker.js", [], { serviceName: "kept", [``]: null });',
      ].join("\n"),
    );

    expect(analysis.electron.browser_windows[0]).toMatchObject({
      preload_path: "./kept.js",
      web_preferences_status: "object-literal",
    });
    expect(analysis.electron.utility_processes[0]?.service_name).toBe("kept");
  });

  it("keeps primitive computed keys exact without obscuring preload or service", () => {
    const analysis = analyzeJavaScriptStaticSource(`
      const { BrowserWindow, utilityProcess } = require("electron");
      new BrowserWindow({ webPreferences: {
        preload: "./kept.js", [true]: "boolean", [null]: "null",
        [-1]: "negative", [-0]: "old-zero", [0]: "zero",
        [-(2 as number)]: "typed-negative"
      }, [false]: null });
      utilityProcess.fork("./worker.js", [], { serviceName: "kept", [null]: 1 });
    `);

    expect(analysis.electron.browser_windows[0]).toMatchObject({
      preload_path: "./kept.js",
      web_preferences_status: "object-literal",
      web_preferences: [
        { name: "-1", value: { status: "literal", value: "negative" } },
        { name: "-2", value: { status: "literal", value: "typed-negative" } },
        { name: "0", value: { status: "literal", value: "old-zero" } },
        { name: "0", value: { status: "literal", value: "zero" } },
        { name: "null", value: { status: "literal", value: "null" } },
        { name: "preload", value: { status: "literal", value: "./kept.js" } },
        { name: "true", value: { status: "literal", value: "boolean" } },
      ],
    });
    expect(analysis.electron.utility_processes[0]?.service_name).toBe("kept");
  });
});
