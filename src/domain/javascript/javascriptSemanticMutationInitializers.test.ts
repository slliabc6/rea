import * as t from "@babel/types";
import { describe, expect, it } from "vitest";

import {
  semanticMutationInitializers,
  semanticTopLevelEffectFollowsCapture,
} from "./javascriptSemanticMutationInitializers.js";
import type { JavaScriptSemanticBindingState } from "./javascriptSemanticState.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

describe("parameter references copied into function body bindings", () => {
  it.each([
    ["var arg = []; mutate(arg);", false],
    ["mutate(arg); var arg = [];", true],
    ["if (flag) { var arg = []; } mutate(arg);", true],
  ])(
    "retains the entry reference only when still reachable: %s",
    (body, retained) => {
      const program = parseJavaScriptSource(
        `function result(arg = source) { ${body} }`,
      )?.program;
      const callable = program?.body[0];
      if (program === undefined || !t.isFunctionDeclaration(callable))
        throw new Error("Expected a parsed function declaration");
      const parameter = callable.params[0];
      if (!t.isAssignmentPattern(parameter) || !t.isIdentifier(parameter.left))
        throw new Error("Expected the source parameter binding");
      const parents = new WeakMap<t.Node, t.Node>();
      let replacement: t.Node | undefined;
      let mutation: t.Node | undefined;
      traverseJavaScriptAst(program, {
        enter: (node, parent) => {
          if (parent !== null) parents.set(node, parent);
          if (t.isVariableDeclarator(node) && node.init !== null)
            replacement = node.init;
          if (t.isCallExpression(node)) mutation = node;
        },
      });
      if (replacement === undefined || mutation === undefined)
        throw new Error("Expected a body initializer and subsequent effect");
      const entry = {
        node: parameter.left,
        projection: [],
        entryBody: callable.body,
      };
      const assigned = { node: replacement, projection: [] };
      const binding: JavaScriptSemanticBindingState = {
        bindingId: "body:arg",
        scopeId: "body",
        name: "arg",
        kind: "variable",
        declarationKinds: new Set(),
        mutable: true,
        memberWrites: [],
        escapedPaths: [],
        definitions: [],
        definitionNodes: [],
        initializers: [entry, assigned],
        referenceInitializers: [],
        directOrigins: [],
        runtimeImport: false,
      };
      const origins = semanticMutationInitializers(binding, mutation, parents);
      expect(origins.initializers.includes(entry)).toBe(retained);
      expect(origins.initializers).toContain(assigned);
    },
  );
});

it.each([
  ["capture(); for (const item of items) { overwrite(); }", true],
  ["for (const item of items) { capture(); overwrite(); }", false],
  ["for (const item of items) { overwrite(); } capture();", false],
  [
    "capture(); for (const item of items) { for (const child of item) { overwrite(); } }",
    true,
  ],
  [
    "for (const item of items) { capture(); for (const child of item) { overwrite(); } }",
    false,
  ],
  ["capture(); function later() { overwrite(); }", false],
])(
  "orders an external capture before a repeating effect without ordering repeated captures: %s",
  (source, follows) => {
    const program = parseJavaScriptSource(source)?.program;
    if (program === undefined)
      throw new Error("Expected parsed ordering fixture");
    const parents = new WeakMap<t.Node, t.Node>();
    let capture: t.Node | undefined;
    let effect: t.Node | undefined;
    traverseJavaScriptAst(program, {
      enter: (node, parent) => {
        if (parent !== null) parents.set(node, parent);
        if (
          t.isCallExpression(node) &&
          t.isIdentifier(node.callee, { name: "capture" })
        )
          capture = node;
        if (
          t.isCallExpression(node) &&
          t.isIdentifier(node.callee, { name: "overwrite" })
        )
          effect = node;
      },
    });
    if (capture === undefined || effect === undefined)
      throw new Error("Expected capture and effect calls");
    expect(semanticTopLevelEffectFollowsCapture(capture, effect, parents)).toBe(
      follows,
    );
  },
);
