import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  semanticWriteSiteTarget,
  semanticWriteTargets,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  javaScriptAstChildKeys,
  traverseJavaScriptAstSteps,
} from "./javascriptSemanticTraversal.js";

/** Match Electron's supported module entry points. */
export const ELECTRON_MODULE =
  /^electron(?:\/(?:common|main|renderer|utility))?$/u;

/**
 * Electron's CommonJS exports define no `default` member, so a leading
 * `default` segment can only denote the module object itself, as an ES module
 * default import (`import electron from "electron"`) binds it.
 */
export const electronExportPath = (
  importedPath: readonly string[],
): readonly string[] =>
  importedPath[0] === "default" ? importedPath.slice(1) : importedPath;

/** Static identity recovery cannot establish the absence of Electron usage. */
export const ELECTRON_IDENTITY_LIMITATION =
  "Electron API identity follows proven lexical module aliases and structurally verified module-namespace interop. Other reassignments, dynamic selections, and visibly overwritten namespace members are unresolved; missing findings do not establish absence. Arbitrary call side effects and runtime registration are not evaluated.";

/** Preserve exact property segments instead of flattening literal dotted keys. */
export const electronMemberPath = (
  node: t.Node,
): {
  readonly root: t.Node;
  readonly members: readonly (string | null)[];
} => {
  let root = unwrapJavaScriptExpression(node).node;
  const members: (string | null)[] = [];
  while (t.isMemberExpression(root) || t.isOptionalMemberExpression(root)) {
    members.push(semanticStaticPropertyKey(root.property, root.computed));
    root = unwrapJavaScriptExpression(root.object).node;
  }
  return { root, members: members.toReversed() };
};

/**
 * The canonical identity of the function a captured invocation member read
 * stores: an alias of `callable.call` holds Function.prototype.call's own
 * function object, so reads and writes through the alias share this path.
 */
export const intrinsicInvocationMemberPath = (
  key: "call" | "apply" | "bind",
): readonly string[] => ["intrinsic", "Function", "prototype", key];

/** A known intrinsic callable and its examined positional arguments. */
export interface JavaScriptIntrinsicInvocation {
  readonly kind: "known" | "opaque";
  /** The original bound receiver; rebinding cannot replace it. */
  readonly receiver?: t.Node;
  readonly path: readonly string[];
  readonly arguments:
    | readonly t.CallExpression["arguments"][number][]
    | undefined;
}

/** Distinguish replacing a value from mutating members of the captured object. */
export type JavaScriptIdentityWriteKind =
  | "replace-value"
  | "mutate-object"
  | "opaque";

/** The source boundary after the operands required for this effect are evaluated. */
export const javaScriptIdentityWriteOffset = (node: t.Node): number =>
  (t.isForOfStatement(node) || t.isForInStatement(node)
    ? node.right.end
    : t.isCallExpression(node) ||
        t.isOptionalCallExpression(node) ||
        t.isAssignmentExpression(node) ||
        t.isUpdateExpression(node) ||
        t.isUnaryExpression(node, { operator: "delete" })
      ? node.end
      : node.start) ?? Infinity;

/**
 * Index writes through possible lexical object identities. Resolve the complete
 * object before appending the written key: self-reference properties can denote
 * the same object, while replacing that property is a distinct write.
 */
export function* collectJavaScriptIdentityWritesSteps(
  program: t.Program,
  origin: (
    root: t.Node,
    kind: "binding" | "member" | "opaque-call",
    writeSite: t.Node,
  ) => readonly (readonly (string | null)[])[],
  intrinsicInvocation: (
    node: t.CallExpression | t.OptionalCallExpression,
  ) => JavaScriptIntrinsicInvocation | undefined,
  staticString: (node: t.Node | undefined) => string | undefined,
  freshObject: (node: t.Node) => boolean,
  retain: (
    node: t.Node,
    path: readonly (string | null)[],
    kind: JavaScriptIdentityWriteKind,
  ) => void,
  observeEvaluation?: (node: t.Node) => void,
): Generator<void> {
  const objectMutators = new Set([
    "defineProperty",
    "defineProperties",
    "assign",
    "setPrototypeOf",
  ]);
  const reflectMutators = new Set([
    "set",
    "deleteProperty",
    "defineProperty",
    "setPrototypeOf",
  ]);
  const keyedMutators = new Set(["set", "deleteProperty", "defineProperty"]);
  const retainCallEffects = (
    node: t.CallExpression | t.OptionalCallExpression,
  ): void => {
    const invocation = intrinsicInvocation(node);
    if (invocation?.kind === "opaque") {
      for (const scope of origin(node, "opaque-call", node))
        retain(node, scope, "opaque");
      return;
    }
    const callee = invocation?.path;
    const arguments_ = invocation?.arguments;
    const method = callee?.at(-1);
    const owner = callee?.length === 3 ? callee[1] : undefined;
    if (
      (owner === "Object" && objectMutators.has(method ?? "")) ||
      (owner === "Reflect" && reflectMutators.has(method ?? ""))
    ) {
      // Reflect.set can write through its explicit receiver as well as
      // dispatching through its target. Both identities need examination.
      const targets =
        owner === "Reflect" &&
        method === "set" &&
        arguments_ !== undefined &&
        (arguments_.length >= 4 || arguments_.some(t.isSpreadElement))
          ? [
              arguments_[0],
              arguments_.some(t.isSpreadElement) ? undefined : arguments_[3],
            ]
          : [arguments_?.[0]];
      for (const target of targets) {
        // A known mutator with an opaque argument list can overwrite any
        // captured intrinsic. Do not turn an unexamined target into proof.
        if (target === undefined || t.isSpreadElement(target)) {
          for (const scope of origin(node, "opaque-call", node))
            retain(node, scope, "opaque");
        }
        if (t.isNode(target) && !t.isSpreadElement(target)) {
          const identities = origin(target, "member", node);
          if (identities.length > 0) {
            const key = keyedMutators.has(method ?? "")
              ? [staticString(arguments_?.[1]) ?? null]
              : // Mutating a target's contents does not replace the target.
                // Retain an unknown child key, rather than its own identity.
                [null];
            for (const identity of identities)
              retain(
                node,
                [...identity, ...key],
                keyedMutators.has(method ?? "")
                  ? "replace-value"
                  : "mutate-object",
              );
          } else if (!freshObject(target)) {
            for (const scope of origin(node, "opaque-call", node))
              retain(node, scope, "opaque");
          }
        }
      }
    }
  };
  // A write's context locates the enclosing assignment so target identities
  // resolve at the statement position, while the effect node keeps each leaf's
  // exact timing inside a destructuring pattern.
  const retainTarget = (
    leaf: t.Node,
    effect: t.Node,
    context: t.Node = effect,
  ): void => {
    if (t.isIdentifier(leaf)) {
      for (const identity of origin(leaf, "binding", context))
        retain(effect, identity, "replace-value");
      return;
    }
    const member = unwrapJavaScriptExpression(leaf).node;
    if (!t.isMemberExpression(member) && !t.isOptionalMemberExpression(member))
      return;
    const key = semanticStaticPropertyKey(member.property, member.computed);
    for (const identity of origin(member.object, "member", context))
      retain(effect, [...identity, key], "replace-value");
  };
  const targetOf = (node: t.Node): t.Node | undefined =>
    t.isAssignmentExpression(node)
      ? node.left
      : t.isUpdateExpression(node)
        ? node.argument
        : t.isUnaryExpression(node, { operator: "delete" })
          ? node.argument
          : t.isForOfStatement(node) || t.isForInStatement(node)
            ? node.left
            : undefined;
  const isPattern = (node: t.Node | undefined): boolean =>
    t.isArrayPattern(node) || t.isObjectPattern(node);
  // `as` casts and assertions wrap a leaf but evaluate to it; the wrapper's
  // own exit decides the write's timing so a wrapped default target is not
  // recorded before its initializer runs.
  const isTransparentWrapper = (node: t.Node | null | undefined): boolean =>
    node != null && unwrapJavaScriptExpression(node).depth > 0;
  const retainTargets = (node: t.Node): void => {
    const target = targetOf(node);
    if (target !== undefined)
      for (const leaf of semanticWriteTargets(target)) retainTarget(leaf, node);
  };
  const patternLeaves = new WeakSet<t.Node>();
  const patternLeafContexts = new WeakMap<t.Node, t.Node>();
  const loopBodies = new WeakMap<t.Node, t.ForOfStatement | t.ForInStatement>();
  yield* traverseJavaScriptAstSteps(program, {
    childKeys: (node) => {
      // Assignment patterns are lexically before their RHS, but execute after it.
      // A simple default target evaluates its reference before its initializer;
      // a nested pattern starts destructuring only after that initializer.
      if (t.isAssignmentExpression(node) && isPattern(node.left))
        return ["right", "left"];
      if (t.isForOfStatement(node) || t.isForInStatement(node))
        return ["right", "left", "body"];
      if (
        t.isAssignmentPattern(node) &&
        isPattern(unwrapJavaScriptExpression(node.left).node)
      )
        return ["right", "left"];
      if (t.isVariableDeclarator(node) && isPattern(node.id))
        return ["init", "id"];
      return javaScriptAstChildKeys(node);
    },
    enter: (node) => {
      const target = targetOf(node);
      if (isPattern(target) && target !== undefined)
        for (const leaf of semanticWriteTargets(target)) {
          patternLeaves.add(leaf);
          patternLeafContexts.set(leaf, node);
        }
      if (t.isForOfStatement(node) || t.isForInStatement(node))
        loopBodies.set(node.body, node);
      const loop = loopBodies.get(node);
      if (loop !== undefined && !isPattern(loop.left)) {
        observeEvaluation?.(loop);
        retainTargets(loop);
      }
    },
    exit: (node, parent) => {
      observeEvaluation?.(node);
      if (patternLeaves.has(node)) {
        // The default expression runs after the target reference is evaluated,
        // but before its value is written. Later leaves see this completed write.
        // A leaf under transparent wrappers exits first: the outermost
        // wrapper's exit decides, since it is the node `AssignmentPattern.left`
        // actually points at.
        if (isTransparentWrapper(parent)) {
          // Defer to the wrapper's own exit.
        } else if (!t.isAssignmentPattern(parent) || parent.left !== node)
          retainTarget(node, node, patternLeafContexts.get(node) ?? node);
      } else if (
        isTransparentWrapper(node) &&
        patternLeaves.has(unwrapJavaScriptExpression(node).node)
      ) {
        const leaf = unwrapJavaScriptExpression(node).node;
        if (
          !isTransparentWrapper(parent) &&
          (!t.isAssignmentPattern(parent) || parent.left !== node)
        )
          retainTarget(leaf, node, patternLeafContexts.get(leaf) ?? node);
      } else if (
        t.isAssignmentPattern(node) &&
        patternLeaves.has(unwrapJavaScriptExpression(node.left).node)
      )
        retainTarget(
          node.left,
          node,
          patternLeafContexts.get(unwrapJavaScriptExpression(node.left).node) ??
            node,
        );
      if (t.isCallExpression(node) || t.isOptionalCallExpression(node))
        retainCallEffects(node);
      else if (
        !t.isForOfStatement(node) &&
        !t.isForInStatement(node) &&
        !isPattern(targetOf(node))
      )
        retainTargets(node);
    },
  });
}
