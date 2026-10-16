import { parseExpression } from "@babel/parser";
import * as t from "@babel/types";

import type { JavaScriptModuleOrigin } from "./javascriptSemanticIr.js";
import {
  isUnshadowedGlobal,
  resolveSemanticBindingState,
  semanticScopeId,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import { semanticRequireOrigin } from "./javascriptSemanticRequireOrigin.js";
import {
  childNodes,
  javaScriptAstChildKeys,
} from "./javascriptSemanticTraversal.js";
import {
  electronMemberPath,
  intrinsicInvocationMemberPath,
  javaScriptIdentityWriteOffset,
  type JavaScriptIdentityWriteKind,
  type JavaScriptIntrinsicInvocation,
} from "./javascriptElectronMemberWrites.js";
import {
  expandJavaScriptInvocationArguments,
  resolveJavaScriptIntrinsicInvocation,
  type CapturedInvocationMember,
} from "./javascriptIntrinsicInvocation.js";
import { semanticPropertyPathKeyMatches } from "./javascriptSemanticPropertyPaths.js";
import {
  readExactJavaScriptLiteral,
  runtimeFunctionParameters,
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";

// Match the complete Rolldown runtime operations, including its live getters.
// Names and formatting are irrelevant; lexical roles, operators and keys are not.
const TO_ESM = parseExpression(`(mod, isNodeMode, target) => (
  target = mod != null ? __create(__getProtoOf(mod)) : {},
  __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default")
    ? __defProp(target, "default", {value: mod, enumerable: true}) : target, mod)
)`);
const COPY_PROPS = parseExpression(`(to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function")
    for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
      key = keys[i];
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, {
          get: ((k) => from[k]).bind(null, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
    }
  return to;
}`);
const INTRINSICS: Readonly<Record<string, readonly string[]>> = {
  __create: ["Object", "create"],
  __getProtoOf: ["Object", "getPrototypeOf"],
  __defProp: ["Object", "defineProperty"],
  __getOwnPropNames: ["Object", "getOwnPropertyNames"],
  __getOwnPropDesc: ["Object", "getOwnPropertyDescriptor"],
  __hasOwnProp: ["Object", "prototype", "hasOwnProperty"],
};

interface IntrinsicDependency {
  readonly path: readonly string[];
  readonly capturedAt?: t.Node;
}

interface InteropOrigin {
  readonly origin: JavaScriptModuleOrigin;
  readonly dependencies: readonly IntrinsicDependency[];
  readonly defaultIsModule: boolean;
}

interface InteropHelper {
  readonly dependencies: readonly IntrinsicDependency[];
  readonly readyAfter: number;
  readonly identity: boolean;
}

const intrinsicWriteCovers = (
  written: readonly (string | null)[],
  read: readonly string[],
): boolean =>
  written.length <= read.length &&
  written.every((key, index) => {
    const name = read[index];
    return name !== undefined && semanticPropertyPathKeyMatches(key, name);
  });

/** Prove one inert namespace conversion without relaxing general assignment semantics. */
export const createSemanticModuleInterop = (
  state: JavaScriptSemanticAnalysisState,
  options?: {
    readonly intrinsicPath: (node: t.Node) => readonly string[] | undefined;
  },
) => {
  // Evaluation order, unlike source offsets, preserves RHS-before-pattern and
  // each destructuring write before subsequent defaults and computed keys.
  const evaluationOrder = new WeakMap<t.Node, number>();
  let evaluationClock = 0;
  const evaluationOffset = (node: t.Node): number =>
    evaluationClock === 0
      ? (node.start ?? -1)
      : (evaluationOrder.get(node) ?? Infinity);
  const helpers = new Map<string, InteropHelper | null>();
  const origins = new Map<string, InteropOrigin>();
  const calls = new WeakMap<t.Node, InteropOrigin>();
  const intrinsicBindings = new Map<string, readonly string[] | null>();
  const writes: {
    readonly scope: string;
    readonly offset: number;
    readonly path: readonly (string | null)[];
    readonly kind: JavaScriptIdentityWriteKind;
  }[] = [];
  const invocationMemberWriteCovers = (
    write: (typeof writes)[number],
    read: readonly string[],
  ): boolean =>
    (write.kind === "opaque" ||
      // A member mutation retains an unknown child key (`[null]`); the wildcard
      // segment scopes coverage to the mutated object's members and deeper.
      (write.kind === "mutate-object" && write.path.at(-1) === null) ||
      (write.kind === "replace-value" && write.path.length === read.length)) &&
    intrinsicWriteCovers(write.path, read);
  const invalidatedBindings = new Map<string, boolean>();
  const invalidatedCalls = new WeakMap<t.Node, boolean>();
  const opaqueMutationPath = (node: t.Node): readonly string[] => {
    let current: t.Node | undefined = node;
    while (current !== undefined) {
      if (t.isFunction(current))
        return ["opaque-intrinsic", semanticScopeId("function", current)];
      current = state.parentsByNode.get(current);
    }
    return ["intrinsic"];
  };

  const intrinsicPath =
    options?.intrinsicPath ??
    ((node: t.Node): readonly string[] | undefined => {
      let current = node;
      const visited = new Set<string>();
      const pending: { id: string; suffixLength: number }[] = [];
      let suffix: readonly string[] = [];
      const finish = (
        path: readonly string[] | undefined,
      ): readonly string[] | undefined => {
        for (const binding of pending)
          intrinsicBindings.set(
            binding.id,
            path === undefined
              ? null
              : path.slice(0, path.length - binding.suffixLength),
          );
        return path;
      };
      for (;;) {
        const { root, members } = electronMemberPath(current);
        if (members.some((member) => member === null)) return finish(undefined);
        suffix = [...(members as readonly string[]), ...suffix];
        if (t.isSequenceExpression(root)) {
          const value = root.expressions.at(-1);
          if (value === undefined) return finish(undefined);
          current = value;
          continue;
        }
        for (const global of ["Object", "Function", "Reflect"])
          if (isUnshadowedGlobal(root, state, global))
            return finish(["intrinsic", global, ...suffix]);
        for (const global of ["globalThis", "global", "window", "self"])
          if (isUnshadowedGlobal(root, state, global))
            return finish(["intrinsic", ...suffix]);
        if (!t.isIdentifier(root)) return finish(undefined);
        const binding = resolveSemanticBindingState(state, root, root.name);
        const cached =
          binding === undefined
            ? undefined
            : intrinsicBindings.get(binding.bindingId);
        if (cached !== undefined)
          return finish(cached === null ? undefined : [...cached, ...suffix]);
        const initializer = semanticStableInitializer(binding, state);
        if (
          binding === undefined ||
          initializer === undefined ||
          initializer.projection.some((segment) => segment === null) ||
          visited.has(binding.bindingId)
        )
          return finish(undefined);
        visited.add(binding.bindingId);
        pending.push({ id: binding.bindingId, suffixLength: suffix.length });
        suffix = [...initializer.projection.map(String), ...suffix];
        current = initializer.node;
      }
    });

  // A nominal alias path is sufficient for conservative mutation lookup, but
  // helper proof also needs each read to follow initialization. An alias copy
  // retains the earlier function capture; a member read captures it anew.
  const capturedIntrinsic = (node: t.Node): IntrinsicDependency | undefined => {
    const path = intrinsicPath(node);
    if (path === undefined) return undefined;
    const visited = new Set<string>();
    let current = node;
    let capturedAt = node;
    let suffixLength = 0;
    for (;;) {
      current = unwrapJavaScriptExpression(current).node;
      if (suffixLength === 0)
        capturedAt =
          t.isMemberExpression(current) || t.isOptionalMemberExpression(current)
            ? current.property
            : current;
      const { root, members } = electronMemberPath(current);
      suffixLength += members.length;
      if (t.isSequenceExpression(root)) {
        const value = root.expressions.at(-1);
        if (value === undefined) return undefined;
        current = value;
        continue;
      }
      if (!t.isIdentifier(root)) return undefined;
      const binding = resolveSemanticBindingState(state, root, root.name);
      if (binding === undefined) return { path, capturedAt };
      const initializer = semanticStableInitializer(binding, state);
      if (
        initializer === undefined ||
        (initializer.node.end ?? Infinity) >= (root.start ?? -1) ||
        visited.has(binding.bindingId)
      )
        return undefined;
      visited.add(binding.bindingId);
      if (suffixLength === 0) capturedAt = initializer.node;
      suffixLength += initializer.projection.length;
      current = initializer.node;
    }
  };

  const staticString = (node: t.Node | undefined): string | undefined => {
    if (node === undefined) return undefined;
    const visited = new Set<string>();
    let current = node;
    for (;;) {
      const literal = readExactJavaScriptLiteral(current);
      if (literal.found)
        return typeof literal.value === "string" ? literal.value : undefined;
      const expression = unwrapJavaScriptExpression(current).node;
      if (!t.isIdentifier(expression)) return undefined;
      const binding = resolveSemanticBindingState(
        state,
        expression,
        expression.name,
      );
      const initializer = semanticStableInitializer(binding, state);
      if (
        binding === undefined ||
        initializer === undefined ||
        initializer.projection.length !== 0 ||
        (initializer.node.end ?? Infinity) >= (expression.start ?? -1) ||
        visited.has(binding.bindingId)
      )
        return undefined;
      visited.add(binding.bindingId);
      current = initializer.node;
    }
  };

  const intrinsicReadChanged = (
    node: t.Node,
    path: readonly string[],
  ): boolean => {
    let current = unwrapJavaScriptExpression(node).node;
    let currentPath = path;
    const aliases = new Set<string>();
    for (;;) {
      current = unwrapJavaScriptExpression(current).node;
      if (t.isSequenceExpression(current)) {
        const value = current.expressions.at(-1);
        if (value === undefined) return true;
        current = value;
        continue;
      }
      const method = currentPath.at(-1);
      const invocationMethod =
        method === "bind" || method === "call" || method === "apply";
      // Recover the member read at an alias initializer before examining its
      // base capture. Copying a callable does not recapture its original owner.
      if (invocationMethod && t.isIdentifier(current)) {
        const binding = resolveSemanticBindingState(
          state,
          current,
          current.name,
        );
        const initializer = semanticStableInitializer(binding, state);
        if (
          binding !== undefined &&
          initializer !== undefined &&
          initializer.projection.length === 0 &&
          (initializer.node.end ?? Infinity) < (current.start ?? -1) &&
          !aliases.has(binding.bindingId)
        ) {
          aliases.add(binding.bindingId);
          current = initializer.node;
          continue;
        }
      }
      if (
        invocationMethod &&
        (t.isMemberExpression(current) || t.isOptionalMemberExpression(current))
      ) {
        // Reading an invocation member does not recapture the stored function.
        // Check member writes now, then check its base at the earlier capture.
        const scope = opaqueMutationPath(current).join(".");
        const offset = evaluationOffset(current);
        // A nested invocation member reads a slot on the member's own
        // function: `X.apply.apply` reads `Function.prototype.apply.apply`,
        // one segment deeper than the mutated `Function.prototype.apply`.
        const previous = currentPath.at(-2);
        const nestedRead =
          previous === "call" || previous === "apply" || previous === "bind"
            ? ["intrinsic", "Function", "prototype", previous, method]
            : undefined;
        if (
          writes.some(
            (write) =>
              (write.scope === scope || write.scope === "intrinsic") &&
              write.offset < offset &&
              (invocationMemberWriteCovers(write, currentPath) ||
                invocationMemberWriteCovers(write, [
                  "intrinsic",
                  "Function",
                  "prototype",
                  method,
                ]) ||
                (nestedRead !== undefined &&
                  invocationMemberWriteCovers(write, nestedRead))),
          )
        )
          return true;
        current = unwrapJavaScriptExpression(current.object).node;
        currentPath = currentPath.slice(0, -1);
        continue;
      }
      const capture = capturedIntrinsic(current)?.capturedAt ?? current;
      const scope = opaqueMutationPath(capture).join(".");
      return writes.some(
        (write) =>
          (write.scope === scope || write.scope === "intrinsic") &&
          write.offset < evaluationOffset(capture) &&
          (intrinsicWriteCovers(write.path, currentPath) ||
            (invocationMethod &&
              intrinsicWriteCovers(write.path, [
                "intrinsic",
                "Function",
                "prototype",
                method,
              ]))),
      );
    }
  };

  const resolveBoundIntrinsic = (
    node: t.Node,
  ): JavaScriptIntrinsicInvocation | undefined => {
    const visited = new Set<string>();
    const argumentGroups: t.CallExpression["arguments"][] = [];
    const bindReads: t.Node[] = [];
    let opaqueArguments = false;
    let receiver: t.Node | undefined;
    let current = node;
    for (;;) {
      current = unwrapJavaScriptExpression(current).node;
      if (t.isIdentifier(current)) {
        const binding = resolveSemanticBindingState(
          state,
          current,
          current.name,
        );
        const initializer = semanticStableInitializer(binding, state);
        if (
          binding === undefined ||
          initializer === undefined ||
          initializer.projection.length !== 0 ||
          (initializer.node.end ?? Infinity) >= (current.start ?? -1) ||
          visited.has(binding.bindingId)
        )
          return undefined;
        visited.add(binding.bindingId);
        current = initializer.node;
        continue;
      }
      if (!t.isCallExpression(current)) {
        // A bound captured member carries the canonical member's value:
        // `changed = invoke.bind(change, …)` where `invoke = change.call`
        // binds Function.prototype.call itself. Only a bind chain reaches
        // here — a bare member value stays for the invocation resolver's
        // own captured-member handling.
        if (argumentGroups.length === 0) return undefined;
        const capturedMember = capturedInvocationMember(current);
        if (capturedMember === undefined) return undefined;
        if (capturedMember.replaced === true)
          return {
            kind: "opaque",
            path: capturedMember.path,
            arguments: undefined,
          };
        // `invoke.bind = replacement` shadows Function.prototype.bind on
        // the captured member — every recorded `.bind` read must stay
        // intact, exactly as the terminal path below requires.
        const memberPath = intrinsicInvocationMemberPath(capturedMember.key);
        opaqueArguments ||= bindReads.some((capture) =>
          intrinsicReadChanged(capture, [...memberPath, "bind"]),
        );
        return {
          kind: opaqueArguments ? "opaque" : "known",
          path: memberPath,
          ...(receiver === undefined ? {} : { receiver }),
          arguments: opaqueArguments
            ? undefined
            : argumentGroups.toReversed().flat(),
        };
      }
      const { root, members } = electronMemberPath(current.callee);
      let bindTarget = root;
      let bindingArguments: JavaScriptIntrinsicInvocation["arguments"] =
        expandJavaScriptInvocationArguments(current.arguments);
      let captured = capturedIntrinsic(current.callee);
      let terminal = captured?.path.at(-1) === "bind";
      let path: readonly string[] | undefined = captured?.path.slice(0, -1);
      if (members.at(-1) === "bind") {
        // A direct .bind may continue a bound callable, without discarding members.
        if (!terminal && members.length !== 1) return undefined;
        bindReads.push(current.callee);
      } else {
        // Reuse the invocation owner for generic call/apply/Reflect.apply of bind.
        const invocation = resolveJavaScriptIntrinsicInvocation(
          current,
          intrinsicPath,
          boundIntrinsic,
          intrinsicReadChanged,
          capturedInvocationMember,
        );
        if (
          invocation?.kind !== "known" ||
          invocation.path.join(".") !== "intrinsic.Function.prototype.bind" ||
          invocation.receiver === undefined
        )
          return undefined;
        bindTarget = invocation.receiver;
        bindingArguments = invocation.arguments;
        captured = capturedIntrinsic(bindTarget);
        terminal = captured !== undefined;
        path = captured?.path;
        opaqueArguments ||=
          path !== undefined && intrinsicReadChanged(bindTarget, path);
      }
      receiver = bindingArguments?.[0];
      const ownArguments = bindingArguments?.slice(1) ?? [];
      opaqueArguments ||=
        bindingArguments === undefined || t.isSpreadElement(receiver);
      opaqueArguments ||= ownArguments.some((argument) =>
        t.isSpreadElement(argument),
      );
      argumentGroups.push(ownArguments);
      if (!terminal || path === undefined) {
        current = bindTarget;
        continue;
      }
      const boundPath = [...path, "bind"];
      opaqueArguments ||= bindReads.some((capture) =>
        intrinsicReadChanged(capture, boundPath),
      );
      return {
        kind: opaqueArguments ? "opaque" : "known",
        path,
        ...(receiver === undefined ? {} : { receiver }),
        // Rebinding appends arguments to the earlier bound argument list.
        arguments: opaqueArguments
          ? undefined
          : argumentGroups.toReversed().flat(),
      };
    }
  };

  // A sequence evaluates to its tail — `(0, change).call` reads `call` on
  // `change` with `change` as the receiver.
  const peelValueSequence = (node: t.Node): t.Node => {
    let current = unwrapJavaScriptExpression(node).node;
    while (t.isSequenceExpression(current)) {
      const tail = current.expressions.at(-1);
      if (tail === undefined) return current;
      current = unwrapJavaScriptExpression(tail).node;
    }
    return current;
  };

  // Returns one timing node per projection level. An intermediate level's
  // read happens when its property is entered — the key exits before the
  // value subtree runs defaults, so `{call: {missing: x = W, call: v}}`
  // checks the outer slot before `W`: `const {missing: x = (change.call =
  // noop), call: invoke} = change`.
  // Duplicate keys require matching by the binding's own declaration site:
  // `{call: first, …, call: invoke}` reads the slot twice, and `invoke`
  // captures the second read.
  const projectedCaptureAts = (
    node: t.Node,
    keys: readonly (string | number | null)[],
    binding: JavaScriptSemanticBindingState,
  ): readonly t.Node[] => {
    const declarator = state.parentsByNode.get(node);
    if (
      declarator === undefined ||
      !t.isVariableDeclarator(declarator) ||
      !t.isObjectPattern(declarator.id)
    )
      return [node];
    // Walk one projection level at a time — `{call: {call: invoke}}` reads
    // `call` on the outer value, then `call` again inside the nested pattern.
    const search = (
      pattern: t.ObjectPattern,
      path: readonly (string | number | null)[],
      requireName = false,
    ): t.Node[] | undefined => {
      const [key, ...rest] = path;
      let firstMatch: t.Node[] | undefined;
      let namedMatch: t.Node[] | undefined;
      for (const property of pattern.properties) {
        if (!t.isObjectProperty(property)) continue;
        if (semanticStaticPropertyKey(property.key, property.computed) !== key)
          continue;
        let leaf = property.value;
        while (t.isAssignmentPattern(leaf)) leaf = leaf.left;
        if (rest.length > 0) {
          if (t.isObjectPattern(leaf)) {
            // Only a nested subtree declaring this binding's name can be
            // the read that produced the value; otherwise keep scanning
            // sibling properties (duplicate outer keys).
            const inner = search(leaf, rest, true);
            if (inner !== undefined) return [property.key, ...inner];
            const fallback = search(leaf, rest, false);
            if (fallback !== undefined)
              firstMatch ??= [property.key, ...fallback];
          }
          continue;
        }
        firstMatch ??= [leaf];
        // A later duplicate key re-reads and rebinds the slot; the leaf
        // carrying this binding's name is the read that produced the value.
        if (t.isIdentifier(leaf, { name: binding.name })) namedMatch = [leaf];
      }
      return namedMatch ?? (requireName ? undefined : firstMatch);
    };
    return (
      search(declarator.id, keys, true) ?? search(declarator.id, keys) ?? [node]
    );
  };

  // An alias initializer can hold a captured invocation member read, as in
  // `const invoke = bound.call`. The initializer stores the member's function
  // value at read time; follow it so the alias remains a usable callable.
  // Zero-projection identifier aliases (`const copy = invoke`) are followed
  // transitively with a cycle guard. A direct member expression names the
  // same shape — `change.call.call` reads `.call` on the member value.
  const capturedInvocationMember = (
    node: t.Node,
    depth = 0,
  ): CapturedInvocationMember | undefined => {
    const visited = new Set<string>();
    let current = unwrapJavaScriptExpression(node).node;
    for (;;) {
      current = peelValueSequence(current);
      let owner: t.Node;
      let key: "call" | "apply" | "bind" | null;
      let at: t.Node;
      let directOffset = false;
      let projection: readonly (string | null)[] = [];
      let captureLeaves: readonly t.Node[] = [];
      if (
        t.isMemberExpression(current) ||
        t.isOptionalMemberExpression(current)
      ) {
        const rawKey = semanticStaticPropertyKey(
          current.property,
          current.computed,
        );
        key =
          rawKey === "call" || rawKey === "apply" || rawKey === "bind"
            ? rawKey
            : null;
        owner = peelValueSequence(current.object);
        at = current;
      } else if (t.isIdentifier(current)) {
        const binding = resolveSemanticBindingState(
          state,
          current,
          current.name,
        );
        const initializer = semanticStableInitializer(binding, state);
        if (
          binding === undefined ||
          initializer === undefined ||
          (initializer.node.end ?? Infinity) >= (current.start ?? -1) ||
          visited.has(binding.bindingId)
        )
          return undefined;
        visited.add(binding.bindingId);
        const next = peelValueSequence(initializer.node);
        // A comma initializer stores its tail: `const invoke = (0, change.call)`
        // captures the member read; peelValueSequence above already followed it.
        if (t.isIdentifier(next) && initializer.projection.length === 0) {
          current = next;
          continue;
        }
        // A destructured capture stores the projected member directly:
        // `const {call: invoke} = change` binds invoke to change.call.
        if (initializer.projection.length === 0) {
          if (
            !t.isMemberExpression(next) &&
            !t.isOptionalMemberExpression(next)
          )
            return undefined;
          const rawKey = semanticStaticPropertyKey(
            next.property,
            next.computed,
          );
          key =
            rawKey === "call" || rawKey === "apply" || rawKey === "bind"
              ? rawKey
              : null;
          owner = peelValueSequence(next.object);
          at = next;
        } else {
          // Every projected segment must be an invocation member: each read
          // lands on a Function.prototype member value, whose own
          // call/apply/bind members resolve to the same canonical members —
          // `{call: {call: invoke}}` captures Function.prototype.call.
          const projected = initializer.projection;
          if (
            projected.length === 0 ||
            projected.some(
              (segment) =>
                segment !== "call" && segment !== "apply" && segment !== "bind",
            )
          )
            return undefined;
          const memberProjection = projected as readonly (
            | "call"
            | "apply"
            | "bind"
          )[];
          key = memberProjection.at(-1) ?? null;
          projection = memberProjection;
          owner = peelValueSequence(next);
          captureLeaves =
            key === null
              ? [initializer.node]
              : projectedCaptureAts(
                  initializer.node,
                  memberProjection,
                  binding,
                );
          at = captureLeaves.at(-1) ?? initializer.node;
          directOffset = true;
        }
      } else return undefined;
      if (key === null) return undefined;
      // The canonical Function.prototype member identity holds only while
      // the owner is a provable callable: an alias of `custom.call` on
      // application data does not hold the intrinsic member at all. A
      // captured member is itself provable — `outer = invoke.call` reads the
      // member from the function `invoke` already stores.
      let ownerPath = intrinsicPath(owner) ?? boundIntrinsic(owner)?.path;
      if (ownerPath === undefined && depth < 4) {
        const capturedOwner = capturedInvocationMember(owner, depth + 1);
        // A replaced owner stores an unknown value — a member read on it is
        // unknown too. Propagate the replaced marker instead of discarding
        // the capture, or `outer = invoke.call; outer()` loses its effect.
        if (capturedOwner !== undefined) {
          if (capturedOwner.replaced === true)
            return { replaced: true, path: capturedOwner.path };
          ownerPath = intrinsicInvocationMemberPath(capturedOwner.key);
        }
      }
      if (ownerPath === undefined) return undefined;
      // A provable owner whose slot was overwritten before the read stores an
      // unknown replacement in `invoke` — recognized member shape, unknown
      // callable. The call must stay opaque rather than effect-free.
      const ownerMemberPath = [
        ...ownerPath,
        projection.length > 1 ? (projection[0] ?? key) : key,
      ];
      if (!directOffset) {
        if (intrinsicReadChanged(at, ownerMemberPath))
          return { replaced: true, path: ownerMemberPath };
      } else {
        // A destructured read captures the member at the destructuring, but
        // `at` is the RHS identifier — intrinsicReadChanged would follow its
        // binding back to the owner's initializer and miss writes between
        // them. Check each level's slot at that level's own read offset:
        // the outer `call` is read before an inner pattern's defaults run,
        // so a later `change.call = noop` does not replace what was captured.
        const scope = opaqueMutationPath(at).join(".");
        const previous = ownerPath.at(-1);
        // The first level reads the owner's own slot and its inherited
        // canonical member; each later level reads the previous canonical
        // member's own slot plus its inherited member — `{call: {apply:
        // invoke}}` checks `[ownerPath,call]` + `[i,F,p,call]`, then
        // `[i,F,p,call,apply]` + `[i,F,p,apply]`.
        const levelSlots = (level: number): (readonly string[])[] => {
          const segment = projection[level];
          if (segment === null || segment === undefined) return [];
          const inherited = [
            "intrinsic",
            "Function",
            "prototype",
            segment,
          ] as const;
          if (level === 0) {
            const nestedRead =
              previous === "call" || previous === "apply" || previous === "bind"
                ? ([
                    "intrinsic",
                    "Function",
                    "prototype",
                    previous,
                    segment,
                  ] as const)
                : undefined;
            return [
              [...ownerPath, segment],
              inherited,
              ...(nestedRead === undefined ? [] : [nestedRead]),
            ];
          }
          const prior = projection[level - 1];
          if (prior === null || prior === undefined) return [];
          return [
            ["intrinsic", "Function", "prototype", prior, segment],
            inherited,
          ];
        };
        for (let level = 0; level < projection.length; level += 1) {
          const offset = evaluationOffset(captureLeaves[level] ?? at);
          const replaced = levelSlots(level).find((slot) =>
            writes.some(
              (write) =>
                (write.scope === scope || write.scope === "intrinsic") &&
                write.offset < offset &&
                invocationMemberWriteCovers(write, slot),
            ),
          );
          if (replaced !== undefined) return { replaced: true, path: replaced };
        }
      }
      return { owner, key, at };
    }
  };

  // The read side resolves an alias of `callable.call` to the stored member
  // function's identity; writes through the alias must land on that same path
  // or they can never invalidate the captured read. A replaced member carries
  // no intrinsic identity, so it yields no path.
  const capturedInvocationMemberPath = (
    node: t.Node,
  ): readonly string[] | undefined => {
    const captured = capturedInvocationMember(node);
    return captured !== undefined && captured.replaced !== true
      ? intrinsicInvocationMemberPath(captured.key)
      : undefined;
  };

  const activeBoundValues = new WeakSet<t.Node>();
  const boundIntrinsic = (
    node: t.Node,
  ): JavaScriptIntrinsicInvocation | undefined => {
    if (activeBoundValues.has(node)) return undefined;
    activeBoundValues.add(node);
    try {
      return resolveBoundIntrinsic(node);
    } finally {
      activeBoundValues.delete(node);
    }
  };

  const isFreshObject = (node: t.Node): boolean => {
    const visited = new Set<string>();
    let current = node;
    for (;;) {
      current = unwrapJavaScriptExpression(current).node;
      if (
        t.isObjectExpression(current) ||
        t.isArrayExpression(current) ||
        t.isFunction(current) ||
        (t.isClass(current) && !current.decorators?.length) ||
        t.isRegExpLiteral(current)
      )
        return true;
      if (!t.isIdentifier(current)) return false;
      const binding = resolveSemanticBindingState(state, current, current.name);
      const initializer = unprojectedInitializer(binding, state);
      if (
        binding === undefined ||
        initializer === undefined ||
        (!t.isFunctionDeclaration(initializer) &&
          (initializer.end ?? Infinity) >= (current.start ?? -1)) ||
        visited.has(binding.bindingId)
      )
        return false;
      visited.add(binding.bindingId);
      current = initializer;
    }
  };

  const helperProof = (
    binding: JavaScriptSemanticBindingState,
  ): InteropHelper | undefined => {
    const cached = helpers.get(binding.bindingId);
    if (cached !== undefined) return cached ?? undefined;
    helpers.set(binding.bindingId, null);
    if (state.scopesById.get(binding.scopeId)?.kind !== "program")
      return undefined;
    const wrapper = unprojectedInitializer(binding, state);
    if (wrapper === undefined) return undefined;
    if (identityFunction(wrapper, state)) {
      const proof = {
        dependencies: [],
        readyAfter: t.isFunctionDeclaration(wrapper)
          ? -1
          : (wrapper.end ?? Infinity),
        identity: true,
      };
      helpers.set(binding.bindingId, proof);
      return proof;
    }
    const wrapperRoles = canonicalRoles(wrapper, TO_ESM, state);
    const copyBinding = wrapperRoles?.get("__copyProps");
    const copy = unprojectedInitializer(copyBinding, state);
    const copyRoles =
      copy === undefined ? undefined : canonicalRoles(copy, COPY_PROPS, state);
    if (
      wrapperRoles === undefined ||
      copyRoles === undefined ||
      copy === undefined
    )
      return undefined;
    const dependencies: IntrinsicDependency[] = [];
    let readyAfter = Math.max(wrapper.end ?? Infinity, copy.end ?? Infinity);
    for (const roles of [wrapperRoles, copyRoles])
      for (const [role, dependency] of roles) {
        const expected = INTRINSICS[role];
        if (expected === undefined) continue;
        const initializer = unprojectedInitializer(dependency, state);
        const captured =
          initializer === undefined
            ? undefined
            : capturedIntrinsic(initializer);
        if (
          initializer === undefined ||
          captured === undefined ||
          JSON.stringify(captured.path) !==
            JSON.stringify(["intrinsic", ...expected])
        )
          return undefined;
        readyAfter = Math.max(readyAfter, initializer.end ?? Infinity);
        dependencies.push(captured);
        if (role === "__hasOwnProp")
          dependencies.push({ path: [...captured.path, "call"] });
      }
    dependencies.push(
      { path: ["intrinsic", "Function", "prototype", "bind"] },
      { path: ["intrinsic", "Function", "prototype", "call"] },
    );
    const proof = {
      dependencies,
      identity: false,
      readyAfter,
    };
    helpers.set(binding.bindingId, proof);
    return proof;
  };

  const provenCall = (node: t.Node) => {
    if (!t.isCallExpression(node) || !t.isIdentifier(node.callee))
      return undefined;
    const helper = resolveSemanticBindingState(
      state,
      node.callee,
      node.callee.name,
    );
    const proof = helper === undefined ? undefined : helperProof(helper);
    const input = node.arguments[0];
    const mode = node.arguments[1];
    const literalMode =
      mode === undefined
        ? { found: true, value: false }
        : t.isExpression(mode)
          ? readExactJavaScriptLiteral(mode)
          : { found: false };
    if (
      proof === undefined ||
      proof.readyAfter >= (node.start ?? -1) ||
      !t.isExpression(input) ||
      node.arguments.length > 2 ||
      !literalMode.found
    )
      return undefined;
    return {
      input,
      // A truthy node mode forces the module-valued default. Other modes
      // preserve named exports without proving the source's default property.
      defaultIsModule: !proof.identity && Boolean(literalMode.value),
      dependencies: proof.dependencies.map((dependency) => ({
        ...dependency,
        capturedAt: dependency.capturedAt ?? node,
      })),
    };
  };

  const callOrigin = (node: t.Node): InteropOrigin | undefined => {
    const cached = calls.get(node);
    if (cached !== undefined) return cached;
    const { root, members } = electronMemberPath(node);
    if (!members.every((member): member is string => member !== null))
      return undefined;
    const converted = provenCall(root);
    const required =
      converted === undefined
        ? undefined
        : semanticRequireOrigin(converted.input, state)?.origin;
    if (
      converted === undefined ||
      required === undefined ||
      required.importedPath.length !== 0 ||
      (members[0] === "default" && !converted.defaultIsModule)
    )
      return undefined;
    const result = {
      origin: { ...required, importedPath: members },
      dependencies: converted.dependencies,
      defaultIsModule: converted.defaultIsModule,
    };
    calls.set(node, result);
    return result;
  };

  const origin = (
    binding: JavaScriptSemanticBindingState,
  ): InteropOrigin | undefined => {
    const single = semanticStableInitializer(binding, state);
    if (single !== undefined) {
      if (
        !single.projection.every(
          (key): key is string => typeof key === "string",
        )
      )
        return undefined;
      const converted = callOrigin(single.node);
      if (
        converted?.origin.importedPath.length === 0 &&
        single.projection[0] === "default" &&
        !converted.defaultIsModule
      )
        return undefined;
      const result =
        converted === undefined
          ? undefined
          : {
              ...converted,
              origin: {
                ...converted.origin,
                importedPath: [
                  ...converted.origin.importedPath,
                  ...single.projection,
                ],
              },
            };
      if (result !== undefined) origins.set(binding.bindingId, result);
      return result;
    }
    const [initial, converted] = binding.initializers;
    if (
      binding.definitions.length !== 2 ||
      binding.definitions[0]?.kind !== "variable" ||
      binding.definitions[1]?.kind !== "assignment" ||
      binding.initializers.length !== 2 ||
      initial === undefined ||
      converted === undefined ||
      initial.projection.length !== 0 ||
      converted.projection.length !== 0 ||
      state.conditionallySkippedExpressions.has(initial.node)
    )
      return undefined;
    const call = converted.node;
    const assignment = state.parentsByNode.get(call);
    const statement =
      assignment === undefined
        ? undefined
        : state.parentsByNode.get(assignment);
    const declaration = state.parentsByNode.get(initial.node);
    const declarationStatement =
      declaration === undefined
        ? undefined
        : state.parentsByNode.get(declaration);
    if (
      !t.isCallExpression(call) ||
      !t.isIdentifier(call.callee) ||
      !t.isAssignmentExpression(assignment, { operator: "=" }) ||
      assignment.right !== call ||
      !t.isIdentifier(assignment.left, { name: binding.name }) ||
      !t.isExpressionStatement(statement) ||
      !t.isVariableDeclarator(declaration) ||
      !t.isVariableDeclaration(declarationStatement) ||
      state.parentsByNode.get(statement) !==
        state.parentsByNode.get(declarationStatement) ||
      (initial.node.start ?? Infinity) >= (call.start ?? -1)
    )
      return undefined;
    const convertedCall = provenCall(call);
    const input = convertedCall?.input;
    if (
      !t.isIdentifier(input) ||
      resolveSemanticBindingState(state, input, input.name) !== binding
    )
      return undefined;
    const required = semanticRequireOrigin(initial.node, state)?.origin;
    if (required === undefined || required.importedPath.length !== 0)
      return undefined;
    if (convertedCall === undefined) return undefined;
    const result = {
      origin: required,
      dependencies: convertedCall.dependencies,
      defaultIsModule: convertedCall.defaultIsModule,
    };
    origins.set(binding.bindingId, result);
    return result;
  };
  const invalidatedOrigin = (record: InteropOrigin | undefined): boolean =>
    record?.dependencies.some(({ path, capturedAt }) => {
      if (capturedAt === undefined) return true;
      const scope = opaqueMutationPath(capturedAt).join(".");
      // Captured function values survive later replacement of global
      // properties. Other callable bodies are not execution evidence.
      return writes.some(
        (write) =>
          (write.scope === scope || write.scope === "intrinsic") &&
          write.offset < evaluationOffset(capturedAt) &&
          intrinsicWriteCovers(write.path, path),
      );
    }) ?? false;
  return {
    origin,
    callOrigin,
    intrinsicPath,
    intrinsicInvocation: (node: t.CallExpression | t.OptionalCallExpression) =>
      resolveJavaScriptIntrinsicInvocation(
        node,
        intrinsicPath,
        boundIntrinsic,
        intrinsicReadChanged,
        capturedInvocationMember,
      ),
    boundIntrinsic,
    capturedInvocationMember,
    capturedInvocationMemberPath,
    staticString,
    isFreshObject,
    opaqueMutationPath,
    observeEvaluation: (node: t.Node): void => {
      evaluationOrder.set(node, ++evaluationClock);
    },
    retainWrite: (
      node: t.Node,
      path: readonly (string | null)[],
      kind: JavaScriptIdentityWriteKind = "replace-value",
    ) => {
      writes.push({
        scope: opaqueMutationPath(node).join("."),
        offset:
          evaluationClock === 0
            ? javaScriptIdentityWriteOffset(node)
            : evaluationOffset(node),
        path: path[0] === "opaque-intrinsic" ? ["intrinsic"] : path,
        kind,
      });
    },
    invalidated: (binding: JavaScriptSemanticBindingState): boolean => {
      const cached = invalidatedBindings.get(binding.bindingId);
      if (cached !== undefined) return cached;
      const result = invalidatedOrigin(origins.get(binding.bindingId));
      invalidatedBindings.set(binding.bindingId, result);
      return result;
    },
    invalidatedCall: (node: t.Node): boolean => {
      const cached = invalidatedCalls.get(node);
      if (cached !== undefined) return cached;
      const result = invalidatedOrigin(calls.get(node));
      invalidatedCalls.set(node, result);
      return result;
    },
  };
};

const identityFunction = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  if (
    !t.isFunction(node) ||
    node.async ||
    node.generator ||
    runtimeFunctionParameters(node).length !== 1
  )
    return false;
  const parameter = runtimeFunctionParameters(node)[0];
  const result = t.isBlockStatement(node.body)
    ? node.body.body.length === 1 && t.isReturnStatement(node.body.body[0])
      ? node.body.body[0].argument
      : undefined
    : node.body;
  return (
    t.isIdentifier(parameter) &&
    t.isIdentifier(result) &&
    resolveSemanticBindingState(state, parameter, parameter.name) !==
      undefined &&
    resolveSemanticBindingState(state, parameter, parameter.name) ===
      resolveSemanticBindingState(state, result, result.name)
  );
};

const unprojectedInitializer = (
  binding: JavaScriptSemanticBindingState | undefined,
  state: JavaScriptSemanticAnalysisState,
): t.Node | undefined => {
  const initializer = semanticStableInitializer(binding, state);
  return initializer?.projection.length === 0 ? initializer.node : undefined;
};

/** Match operations and lexical roles, allowing single-statement control blocks. */
const canonicalRoles = (
  actual: t.Node,
  pattern: t.Node,
  state: JavaScriptSemanticAnalysisState,
): ReadonlyMap<string, JavaScriptSemanticBindingState> | undefined => {
  const roles = new Map<string, JavaScriptSemanticBindingState>();
  const used = new Map<string, string>();
  const pending: { actual: t.Node; pattern: t.Node; parent: t.Node | null }[] =
    [{ actual, pattern, parent: null }];
  while (pending.length !== 0) {
    const pair = pending.pop();
    if (pair === undefined) return undefined;
    const { parent } = pair;
    const controlBody =
      (t.isIfStatement(parent) &&
        (parent.consequent === pair.pattern ||
          parent.alternate === pair.pattern)) ||
      (t.isForStatement(parent) && parent.body === pair.pattern);
    const node = controlBody ? controlBodyOperation(pair.actual) : pair.actual;
    const expected = controlBody
      ? controlBodyOperation(pair.pattern)
      : pair.pattern;
    if (node.type !== expected.type) return undefined;
    const literalKey =
      parent !== null &&
      ((t.isMemberExpression(parent) &&
        !parent.computed &&
        parent.property === expected) ||
        (t.isObjectProperty(parent) &&
          !parent.computed &&
          parent.key === expected));
    if (t.isIdentifier(expected) && t.isIdentifier(node) && !literalKey) {
      const binding = resolveSemanticBindingState(state, node, node.name);
      if (
        binding === undefined ||
        (roles.has(expected.name) && roles.get(expected.name) !== binding) ||
        (used.has(binding.bindingId) &&
          used.get(binding.bindingId) !== expected.name)
      )
        return undefined;
      roles.set(expected.name, binding);
      used.set(binding.bindingId, expected.name);
    }
    const visitorKeys = javaScriptAstChildKeys(expected);
    for (const [key, field] of Object.entries(
      t.NODE_FIELDS[expected.type] ?? {},
    )) {
      if (
        visitorKeys.includes(key) ||
        (t.isIdentifier(expected) && key === "name" && !literalKey)
      )
        continue;
      const fallback: unknown = Reflect.get(field, "default");
      if (
        JSON.stringify(Reflect.get(node, key) ?? fallback) !==
        JSON.stringify(Reflect.get(expected, key) ?? fallback)
      )
        return undefined;
    }
    const children = childNodes(node),
      expectedChildren = childNodes(expected);
    if (children.length !== expectedChildren.length) return undefined;
    for (const [index, child] of children.entries()) {
      const expectedChild = expectedChildren[index];
      if (expectedChild !== undefined)
        pending.push({
          actual: child,
          pattern: expectedChild,
          parent: expected,
        });
    }
  }
  return roles;
};

// Braces around one control-body statement do not add operations. Keep other
// blocks, directives and extra statements intact; their semantics need proof.
// Lexical declarations/references still pass through canonicalRoles' bijection.
const controlBodyOperation = (node: t.Node): t.Node => {
  while (
    t.isBlockStatement(node) &&
    node.directives.length === 0 &&
    node.body.length === 1
  ) {
    const statement = node.body[0];
    if (statement === undefined) break;
    node = statement;
  }
  return node;
};
