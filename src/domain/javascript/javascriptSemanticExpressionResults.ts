import * as t from "@babel/types";

import {
  javaScriptExactResultOperand,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  semanticInitializerPrecedesRead,
  type SemanticExecutionFrame,
} from "./javascriptSemanticEvaluationOrder.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";

/** Compare a local binding event in its own lexical activation, without guessing callers. */
const lexicalFrame = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): SemanticExecutionFrame => {
  let current = node;
  for (;;) {
    const parent = state.parentsByNode.get(current);
    if (parent === undefined || t.isFunction(parent) || t.isProgram(parent))
      return { owner: parent ?? current, point: node };
    current = parent;
  }
};

/** A selected assignment result requires a writable, already initialised local binding. */
const assignmentCanComplete = (
  node: t.AssignmentExpression,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const target = unwrapJavaScriptExpression(node.left).node;
  if (!t.isIdentifier(target)) return false;
  const binding = resolveSemanticBindingState(state, target, target.name);
  if (
    binding === undefined ||
    binding.runtimeImport ||
    [...binding.declarationKinds].some(
      (kind) => kind === "const" || kind === "using" || kind === "await using",
    )
  )
    return false;
  if (binding.declarationKinds.has("var")) return true;
  // Parameters, private function-name environments and arbitrary property writes
  // require different initialization/setter proofs and remain unresolved here.
  if (!binding.declarationKinds.has("let")) return false;
  return binding.definitionNodes.some((bindingNode) => {
    let declaration: t.Node | undefined = bindingNode;
    while (
      declaration !== undefined &&
      !t.isVariableDeclarator(declaration) &&
      !t.isFunction(declaration)
    )
      declaration = state.parentsByNode.get(declaration);
    return (
      t.isVariableDeclarator(declaration) &&
      semanticInitializerPrecedesRead({
        initializer: declaration,
        read: node,
        bindingNode,
        parents: state.parentsByNode,
        initializerContexts: [lexicalFrame(declaration, state)],
        readContexts: [lexicalFrame(node, state)],
      }) === true
    );
  });
};

/** Value identity follows assignment RHS only after its target write can complete. */
export const semanticExactResultOperand = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.Node | undefined =>
  javaScriptExactResultOperand(node, (assignment) =>
    assignmentCanComplete(assignment, state),
  );
