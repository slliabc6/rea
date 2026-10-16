import * as t from "@babel/types";

import {
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
  javaScriptClassField,
} from "./javascriptAstValues.js";

const preserveGrouping = { stopAtParentheses: true } as const;

/** One lexical activation and the evaluation point it contributes to a read. */
export interface SemanticExecutionFrame {
  readonly owner: t.Node;
  readonly point: t.Node;
}

/** Compare initialization only in the nearest shared, proven activation. */
export const semanticInitializerPrecedesRead = ({
  initializer,
  read,
  bindingNode,
  parents,
  initializerContexts,
  readContexts,
}: {
  readonly initializer: t.Node;
  readonly read: t.Node;
  readonly bindingNode?: t.Node;
  readonly parents: WeakMap<t.Node, t.Node>;
  readonly initializerContexts: readonly SemanticExecutionFrame[];
  readonly readContexts: readonly SemanticExecutionFrame[];
}): boolean | undefined => {
  let current: t.Node | undefined = initializer;
  while (
    current !== undefined &&
    !t.isFunction(current) &&
    !t.isProgram(current)
  ) {
    if (t.isSwitchCase(current)) {
      let ancestor: t.Node | undefined = read;
      while (ancestor !== undefined && ancestor !== current)
        ancestor = parents.get(ancestor);
      if (ancestor === undefined) return false;
    }
    current = parents.get(current);
  }
  const shared = readContexts.find(({ owner }) =>
    initializerContexts.some((frame) => frame.owner === owner),
  );
  if (shared === undefined) return undefined;
  const patternOrder =
    bindingNode === undefined
      ? undefined
      : semanticPatternInitializationPrecedesRead(bindingNode, read, parents);
  if (patternOrder !== undefined) return patternOrder;
  return !initializerContexts.some(
    (before) =>
      before.owner === shared.owner &&
      readContexts.some(
        (after) =>
          after.owner === shared.owner &&
          (before.point.end ?? Infinity) >= (after.point.start ?? -1),
      ),
  );
};

/** Order a binding event against evaluation in the same declaration pattern. */
export const semanticPatternInitializationPrecedesRead = (
  binding: t.Node,
  read: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): boolean | undefined => {
  if (!t.isIdentifier(binding) || t.isVariableDeclarator(parents.get(binding)))
    return undefined;
  const path = new Map<t.Node, t.Node>();
  let child: t.Node = binding;
  let declarator: t.VariableDeclarator | undefined;
  for (;;) {
    const parent = parents.get(child);
    if (parent === undefined || t.isFunction(parent) || t.isProgram(parent))
      break;
    path.set(parent, child);
    if (t.isVariableDeclarator(parent)) {
      if (parent.id !== child) return undefined;
      declarator = parent;
      break;
    }
    child = parent;
  }
  if (declarator === undefined) return undefined;
  child = read;
  for (;;) {
    const parent = parents.get(child);
    if (parent === undefined) return undefined;
    const boundChild = path.get(parent);
    if (boundChild !== undefined) {
      const siblings: readonly (t.Node | null)[] | undefined =
        t.isObjectPattern(parent)
          ? parent.properties
          : t.isArrayPattern(parent)
            ? parent.elements
            : undefined;
      if (siblings !== undefined) {
        const before = siblings.indexOf(boundChild);
        const after = siblings.indexOf(child);
        return before >= 0 && after >= 0 ? before < after : undefined;
      }
      // RHS, computed key and a selected default all precede their own binding.
      if (
        t.isVariableDeclarator(parent) ||
        t.isAssignmentPattern(parent) ||
        t.isObjectProperty(parent)
      )
        return false;
      return undefined;
    }
    child = parent;
  }
};

/** Whether call arguments or an optional member key may be short-circuited. */
export const javaScriptOptionalOperandsMayBeSkipped = (
  node:
    | t.CallExpression
    | t.OptionalCallExpression
    | t.OptionalMemberExpression,
): boolean =>
  ((t.isOptionalCallExpression(node) || t.isOptionalMemberExpression(node)) &&
    node.optional) ||
  optionalChainMayShortCircuit(
    t.isOptionalMemberExpression(node) ? node.object : node.callee,
  );

export type JavaScriptSemanticIterationCardinality =
  | "empty"
  | "nonempty"
  | "unknown";

/** Exact source-only cardinality for literal loop heads. */
export const semanticIterationCardinality = (
  loop: t.ForInStatement | t.ForOfStatement,
  prototypeMayAffectEnumeration: boolean | undefined,
): JavaScriptSemanticIterationCardinality => {
  const iterable = unwrapJavaScriptExpression(loop.right).node;
  if (t.isForOfStatement(loop)) {
    if (prototypeMayAffectEnumeration !== false) return "unknown";
    if (t.isArrayExpression(iterable)) {
      if (iterable.elements.length === 0) return "empty";
      if (
        iterable.elements.some(
          (element) => element === null || !t.isSpreadElement(element),
        )
      )
        return "nonempty";
      return "unknown";
    }
    if (t.isStringLiteral(iterable))
      return iterable.value.length === 0 ? "empty" : "nonempty";
    return "unknown";
  }
  if (t.isObjectExpression(iterable)) {
    let prototype: t.Node | undefined;
    for (const property of iterable.properties) {
      if (t.isSpreadElement(property)) return "unknown";
      const key = semanticStaticPropertyKey(property.key, property.computed);
      if (
        t.isObjectProperty(property) &&
        !property.computed &&
        !property.shorthand &&
        key === "__proto__"
      ) {
        prototype = unwrapJavaScriptExpression(property.value).node;
        continue;
      }
      if (key === null) return "unknown";
      return "nonempty";
    }
    if (t.isNullLiteral(prototype)) return "empty";
    if (prototype !== undefined && !readExactJavaScriptLiteral(prototype).found)
      return "unknown";
    return prototypeMayAffectEnumeration === false ? "empty" : "unknown";
  }
  if (t.isNullLiteral(iterable)) return "empty";
  if (t.isStringLiteral(iterable) && iterable.value.length > 0)
    return "nonempty";
  if (readExactJavaScriptLiteral(iterable).found)
    return prototypeMayAffectEnumeration === false ? "empty" : "unknown";
  return "unknown";
};

/** Instance values run on construction; their computed keys run at definition. */
export const delayedInstanceFieldValue = (
  parent: t.Node | undefined,
  child: t.Node | undefined,
): boolean =>
  javaScriptClassField(parent) && !parent.static && parent.value === child;

/** Shared branch facts for binding writes and their possible execution positions. */
export const semanticBranchMayBeSkipped = (
  parent: t.Node,
  child: t.Node,
): boolean => {
  if (delayedInstanceFieldValue(parent, child)) return true;
  if (t.isIfStatement(parent))
    return child === parent.consequent || child === parent.alternate;
  if (t.isSwitchCase(parent)) return true;
  if (t.isTryStatement(parent))
    return child === parent.block || child === parent.handler;
  if (t.isForStatement(parent))
    return child === parent.body || child === parent.update;
  if (t.isWhileStatement(parent)) return child === parent.body;
  if (t.isDoWhileStatement(parent)) return child === parent.test;
  if (t.isForInStatement(parent) || t.isForOfStatement(parent))
    return child === parent.left || child === parent.body;
  if (t.isLogicalExpression(parent)) return child === parent.right;
  if (t.isAssignmentPattern(parent)) return child === parent.right;
  if (t.isAssignmentExpression(parent))
    return (
      ["&&=", "||=", "??="].includes(parent.operator) && child === parent.right
    );
  if (t.isConditionalExpression(parent))
    return child === parent.consequent || child === parent.alternate;
  if (t.isOptionalCallExpression(parent) || t.isCallExpression(parent))
    return (
      parent.arguments.includes(child as t.Expression) &&
      javaScriptOptionalOperandsMayBeSkipped(parent)
    );
  if (t.isOptionalMemberExpression(parent))
    return (
      parent.computed &&
      child === parent.property &&
      javaScriptOptionalOperandsMayBeSkipped(parent)
    );
  return false;
};

const optionalChainMayShortCircuit = (expression: t.Node): boolean => {
  let current = expression;
  while (true) {
    // Parentheses terminate optional-chain short-circuiting. In particular,
    // `(foo?.bar)(arg)` evaluates arg before attempting the call.
    if (current.extra?.parenthesized === true) return false;
    const unwrapped = unwrapJavaScriptExpression(
      current,
      preserveGrouping,
    ).node;
    if (unwrapped !== current) {
      current = unwrapped;
      continue;
    }
    if (t.isOptionalMemberExpression(current)) {
      if (current.optional) return true;
      current = current.object;
    } else if (t.isMemberExpression(current)) current = current.object;
    else if (t.isOptionalCallExpression(current)) {
      if (current.optional) return true;
      current = current.callee;
    } else if (t.isCallExpression(current)) current = current.callee;
    else return false;
  }
};
