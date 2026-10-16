import * as t from "@babel/types";

import {
  isNullishJavaScriptSyntax,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import { collectSemanticReferences } from "./javascriptSemanticProjection.js";
import { SEMANTIC_EXPRESSION_DEPTH_LIMIT } from "./javascriptSemanticResourceLimits.js";
import {
  isUnshadowedGlobal,
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";

type ExpressionShape = "array" | "nullish" | "unknown";

const evalExposure = new WeakMap<JavaScriptSemanticAnalysisState, boolean>();

const hasEvalExposure = (state: JavaScriptSemanticAnalysisState): boolean => {
  let exposed = evalExposure.get(state);
  if (exposed === undefined) {
    // Match the shared GraphQL ownership boundary: a lexical eval reference
    // may be the intrinsic, even when supplied through a parameter. Do not
    // infer which activation or execution order could change local bindings.
    exposed =
      collectSemanticReferences(state.program, state, "eval").length > 0;
    evalExposure.set(state, exposed);
  }
  return exposed;
};

/** Query identity without claiming container contents or intrinsic length. */
export const createSemanticExpressionShapeResolver = (
  state: JavaScriptSemanticAnalysisState,
): {
  readonly isArray: (node: t.Node) => boolean;
  readonly isNullish: (node: t.Node) => boolean;
} => {
  // Read nodes, binding facts and parent links are fixed for this source. Depth
  // is part of the key so a budget-limited alias never poisons a shallower read.
  const cache = new WeakMap<t.Node, Map<number, ExpressionShape>>();
  const active = new Set<t.Node>();
  const commonShape = (
    nodes: readonly t.Node[],
    depth: number,
  ): ExpressionShape => {
    const first = nodes[0];
    if (first === undefined) return "unknown";
    const shape = resolve(first, depth);
    return shape !== "unknown" &&
      nodes.slice(1).every((node) => resolve(node, depth) === shape)
      ? shape
      : "unknown";
  };
  const resolve = (input: t.Node, depth: number): ExpressionShape => {
    const { node, depth: wrappers } = unwrapJavaScriptExpression(input);
    depth += wrappers;
    if (depth > SEMANTIC_EXPRESSION_DEPTH_LIMIT || active.has(node))
      return "unknown";
    if (t.isIdentifier(node) && hasEvalExposure(state)) return "unknown";
    const cached = cache.get(node)?.get(depth);
    if (cached !== undefined) return cached;
    active.add(node);
    let shape: ExpressionShape = "unknown";
    try {
      if (t.isArrayExpression(node)) shape = "array";
      else if (
        isNullishJavaScriptSyntax(node) ||
        isUnshadowedGlobal(node, state, "undefined")
      )
        shape = "nullish";
      else if (t.isConditionalExpression(node))
        shape = commonShape([node.consequent, node.alternate], depth + 1);
      else if (t.isLogicalExpression(node))
        shape = commonShape([node.left, node.right], depth + 1);
      else if (t.isIdentifier(node)) {
        const binding = resolveSemanticBindingState(state, node, node.name);
        if (binding !== undefined) {
          const read = semanticBindingAtRead(
            binding,
            node,
            state.parentsByNode,
          );
          if (
            read.status === "ordered" &&
            read.hasDefiniteInitializer &&
            read.binding.referenceInitializers.length === 0 &&
            read.binding.initializers.every(
              (initializer) =>
                initializer.projection.length === 0 &&
                !state.conditionallySkippedExpressions.has(initializer.node),
            )
          )
            shape = commonShape(
              read.binding.initializers.map(({ node }) => node),
              depth + 1,
            );
        }
      }
    } finally {
      active.delete(node);
    }
    const depths = cache.get(node) ?? new Map<number, ExpressionShape>();
    depths.set(depth, shape);
    cache.set(node, depths);
    return shape;
  };
  return {
    isArray: (node) => resolve(node, 0) === "array",
    isNullish: (node) => resolve(node, 0) === "nullish",
  };
};
