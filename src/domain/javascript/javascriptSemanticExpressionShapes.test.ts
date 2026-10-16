import * as t from "@babel/types";
import { expect, it, vi } from "vitest";

import { indexJavaScriptBindingsSteps } from "./javascriptSemanticAnalysis.js";
import { createSemanticExpressionShapeResolver } from "./javascriptSemanticExpressionShapes.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";

const indexed = (source: string) => {
  const parsed = parseJavaScriptSource(source, "shapes.ts");
  if (parsed === null) throw new Error("Expected valid shape fixture");
  const steps = indexJavaScriptBindingsSteps(parsed.program);
  let step = steps.next();
  while (step.done !== true) step = steps.next();
  const reads: t.Node[] = [];
  traverseJavaScriptAst(parsed.program, {
    enter(node) {
      if (
        t.isCallExpression(node) &&
        t.isIdentifier(node.callee, { name: "read" })
      ) {
        const argument = node.arguments[0];
        if (argument !== undefined) reads.push(argument);
      }
    },
  });
  return { state: step.value, reads };
};

it.each([
  ["read([]); read([...incoming]);", ["array", "array"]],
  [
    "read(null); read(void sideEffect()); read(undefined);",
    ["nullish", "nullish", "nullish"],
  ],
  ["function f(undefined) { read(undefined); }", ["unknown"]],
  ["const undefined = {}; read(undefined);", ["unknown"]],
  ["read(future); const future = []; read(future);", ["unknown", "array"]],
  [
    "let a=[]; read(a); const saved=a; a=incoming; read(a); read(saved);",
    ["array", "unknown", "array"],
  ],
  [
    "let a=null; const saved=a; a=incoming; read(a); read(saved);",
    ["unknown", "nullish"],
  ],
  ["let a; const saved=a; a=[]; read(saved); read(a);", ["unknown", "array"]],
  ["let a; if(flag)a=[]; read(a);", ["unknown"]],
  ["let a=[]; if(flag)a=incoming; read(a);", ["unknown"]],
  ["let a; function initialize(){a=[];} function f(){read(a);}", ["unknown"]],
  ["const a=flag?[]:[...incoming]; read(a);", ["array"]],
  ["const a=flag?null:undefined; read(a);", ["nullish"]],
  ["const a=flag?[]:incoming; read(a);", ["unknown"]],
  ["let a=flag?[]:a; read(a);", ["unknown"]],
  ["const {a}={a:[]}; read(a);", ["unknown"]],
  ["import a from './external'; read(a);", ["unknown"]],
  ["const a=[]; a.length=incoming; a.extra=1; consume(a); read(a);", ["array"]],
  ["function f(){let a=[]; eval('a={}'); read(a);}", ["unknown"]],
  ["function f(){eval('var undefined={}'); read(undefined);}", ["unknown"]],
  ["function f(eval){let a=[]; eval('a={}'); read(a);}", ["unknown"]],
] as const)(
  "preserves certain shapes and unknowns at each read: %s",
  (source, expected) => {
    const { state, reads } = indexed(source);
    const shared = createSemanticExpressionShapeResolver(state);
    const shape = (resolver: typeof shared, node: t.Node) =>
      resolver.isArray(node)
        ? "array"
        : resolver.isNullish(node)
          ? "nullish"
          : "unknown";
    expect(reads).toHaveLength(expected.length);
    for (const order of [reads, reads.toReversed(), [...reads, ...reads]]) {
      for (const node of order) {
        expect(shape(shared, node)).toBe(expected[reads.indexOf(node)]);
        expect(shape(shared, node)).toBe(
          shape(createSemanticExpressionShapeResolver(state), node),
        );
      }
    }
  },
);

it("bounds shared alias diamonds without evaluating array contents", () => {
  const measure = (depth: number) => {
    const { state, reads } = indexed(`const a0=[];
      ${Array.from({ length: depth }, (_, i) => `const a${i + 1}=flag?a${i}:a${i};`).join("\n")}
      read(a${depth});`);
    const lookups = state.scopes.map((scope) =>
      vi.spyOn(scope.bindings, "get"),
    );
    try {
      expect(
        createSemanticExpressionShapeResolver(state).isArray(reads[0]!),
      ).toBe(true);
      return lookups.reduce(
        (total, lookup) => total + lookup.mock.calls.length,
        0,
      );
    } finally {
      for (const lookup of lookups) lookup.mockRestore();
    }
  };
  const small = measure(8);
  expect(small).toBeGreaterThan(0);
  expect(measure(12)).toBeLessThan(3 * small);
});
