import * as t from "@babel/types";

import {
  intrinsicInvocationMemberPath,
  type JavaScriptIntrinsicInvocation,
} from "./javascriptElectronMemberWrites.js";
import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";

/** Expand only literal array spreads whose positional arguments are all known. */
export const expandJavaScriptInvocationArguments = (
  arguments_: readonly t.CallExpression["arguments"][number][],
): t.CallExpression["arguments"] => {
  const expanded: t.CallExpression["arguments"] = [];
  const pending = [...arguments_].reverse();
  while (pending.length > 0) {
    const argument = pending.pop();
    if (argument === undefined) break;
    const array = t.isSpreadElement(argument)
      ? unwrapJavaScriptExpression(argument.argument).node
      : undefined;
    if (
      t.isArrayExpression(array) &&
      array.elements.every(
        (element) => t.isExpression(element) || t.isSpreadElement(element),
      )
    )
      for (let index = array.elements.length - 1; index >= 0; index -= 1) {
        const element = array.elements[index];
        if (element !== null && element !== undefined) pending.push(element);
      }
    else expanded.push(argument);
  }
  return expanded;
};

const arrayArguments = (node: t.Node | undefined) => {
  const array =
    node === undefined ? undefined : unwrapJavaScriptExpression(node).node;
  if (
    !t.isArrayExpression(array) ||
    array.elements.some((element) => element === null)
  )
    return undefined;
  const expanded = expandJavaScriptInvocationArguments(
    array.elements.filter(
      (element): element is t.Expression | t.SpreadElement => element !== null,
    ),
  );
  return expanded.every((element) => t.isExpression(element))
    ? expanded.filter((element): element is t.Expression =>
        t.isExpression(element),
      )
    : undefined;
};

const invocationArguments = (
  method: "call" | "apply",
  arguments_: JavaScriptIntrinsicInvocation["arguments"],
) =>
  t.isSpreadElement(arguments_?.[0])
    ? undefined
    : method === "apply"
      ? arrayArguments(arguments_?.[1])
      : arguments_?.slice(1);

/**
 * The callee can name a captured invocation member in three ways: `owner` +
 * `key` describe the intact read (`at` marks its position for read-timing
 * checks); `replaced` means the member shape is recognized on a provable
 * callable but its owner slot was overwritten before capture — the stored
 * value is unknown, not the intrinsic; `undefined` means the alias does not
 * reference such a member at all.
 */
export type CapturedInvocationMember =
  | {
      readonly owner: t.Node;
      readonly key: "call" | "apply" | "bind";
      readonly at: t.Node;
      readonly replaced?: false;
    }
  | { readonly replaced: true; readonly path: readonly string[] };

/**
 * Normalize known invocation syntax once, retaining bound argument prefixes.
 * Binding a function alone is not a write; only its eventual call is examined.
 */
export const resolveJavaScriptIntrinsicInvocation = (
  node: t.CallExpression | t.OptionalCallExpression,
  intrinsicPath: (node: t.Node) => readonly string[] | undefined,
  boundIntrinsic: (node: t.Node) => JavaScriptIntrinsicInvocation | undefined,
  intrinsicReadChanged: (node: t.Node, path: readonly string[]) => boolean,
  memberRead?: (node: t.Node) => CapturedInvocationMember | undefined,
): JavaScriptIntrinsicInvocation | undefined => {
  const visited = new Set<string>();
  const nodeIds = new Map<t.Node, number>();
  const idOf = (node: t.Node): number => {
    let id = nodeIds.get(node);
    if (id === undefined) {
      id = nodeIds.size;
      nodeIds.set(node, id);
    }
    return id;
  };
  let callee: t.Node = node.callee;
  // A captured member substituted in as the callee behaves like a member
  // read `callee.<key>` — e.g. `invoke` aliasing `change.call` names
  // Function.prototype.call. The view survives unwrapping and sequence
  // peeling; `at` keeps the capture-time position for read checks.
  let virtualMember:
    | { readonly key: "call" | "apply" | "bind"; readonly at: t.Node }
    | undefined;
  let arguments_: JavaScriptIntrinsicInvocation["arguments"] =
    expandJavaScriptInvocationArguments(node.arguments);
  let receiver: t.Node | undefined;
  let explicitReceiver = false;
  let boundPrefixApplied = false;
  for (;;) {
    callee = unwrapJavaScriptExpression(callee).node;
    if (t.isSequenceExpression(callee)) {
      const finalExpression = callee.expressions.at(-1);
      if (finalExpression === undefined) return undefined;
      // The comma operator produces a value and erases the member receiver.
      // An explicit receiver already supplied by an outer call remains intact.
      explicitReceiver = true;
      callee = finalExpression;
      continue;
    }
    // Re-entering the same node with a different receiver/argument state is
    // legitimate — `invoke.call(invoke, change, …)` passes through
    // Function.prototype.call repeatedly. Cycle detection keys on the full
    // invocation state, not the AST node alone.
    const stateKey = [
      idOf(callee),
      receiver === undefined ? -1 : idOf(receiver),
      explicitReceiver ? 1 : 0,
      arguments_ === undefined ? -1 : arguments_.length,
      virtualMember === undefined
        ? ""
        : `${virtualMember.key}@${idOf(virtualMember.at)}`,
    ].join("|");
    if (visited.has(stateKey)) return undefined;
    visited.add(stateKey);
    const virtual = virtualMember;
    virtualMember = undefined;
    let path = intrinsicPath(callee);
    if (path !== undefined && intrinsicReadChanged(callee, path))
      return { kind: "opaque", path, arguments: undefined };
    if (path === undefined) {
      const memberObjectRaw: t.Node | undefined =
        virtual !== undefined
          ? callee
          : t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)
            ? callee.object
            : undefined;
      // A sequence in object position evaluates to its tail — `(0, change).call`
      // still reads `call` on `change` with `change` as the receiver.
      let memberObject: t.Node | undefined = memberObjectRaw;
      while (memberObject !== undefined) {
        const unwrapped = unwrapJavaScriptExpression(memberObject).node;
        if (!t.isSequenceExpression(unwrapped)) {
          memberObject = unwrapped;
          break;
        }
        const tail = unwrapped.expressions.at(-1);
        if (tail === undefined) {
          memberObject = undefined;
          break;
        }
        memberObject = tail;
      }
      const method =
        virtual !== undefined
          ? virtual.key
          : t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)
            ? semanticStaticPropertyKey(callee.property, callee.computed)
            : undefined;
      const memberAt = virtual === undefined ? callee : virtual.at;
      if (method === "bind") {
        // `x.bind(…)` invokes Function.prototype.bind with `x` as its
        // receiver. A captured `bind` member is Function.prototype.bind
        // itself — `rebinder.call(target, …)` binds the explicit receiver
        // instead. Both produce a bound callable the caller continues
        // through boundIntrinsic.
        const bindPath = intrinsicInvocationMemberPath("bind");
        const bound: JavaScriptIntrinsicInvocation | undefined =
          memberObject === undefined ? undefined : boundIntrinsic(memberObject);
        const captured: CapturedInvocationMember | undefined =
          bound === undefined && memberObject !== undefined
            ? memberRead?.(memberObject)
            : undefined;
        if (captured !== undefined && captured.replaced === true)
          return {
            kind: "opaque",
            path: captured.path,
            arguments: undefined,
          };
        const memberPath: readonly string[] | undefined =
          captured === undefined
            ? undefined
            : intrinsicInvocationMemberPath(captured.key);
        // Reading `.bind` re-reads the slot on the owner — a replaced slot
        // executes an unknown function, and a replaced Function.prototype
        // member cannot be assumed intact either.
        if (
          // A virtual member is a synthetic substitution for a captured
          // read — the real read (`invoke.bind`) was already checked; no
          // `owner.bind` slot is read again here.
          (bound !== undefined &&
            virtual === undefined &&
            intrinsicReadChanged(memberAt, [...bound.path, "bind"])) ||
          (captured !== undefined &&
            memberPath !== undefined &&
            intrinsicReadChanged(captured.at, [...memberPath, "bind"])) ||
          intrinsicReadChanged(memberAt, bindPath)
        )
          return { kind: "opaque", path: bindPath, arguments: undefined };
        // An explicit receiver is the bind target even for a direct member
        // callee: `Reflect.apply(change.bind, fn, […])` binds `fn`, never
        // `change`. Without one, the member owner is the target.
        const bindTarget: t.Node | undefined = explicitReceiver
          ? receiver
          : memberObject;
        if (bindTarget === undefined || !t.isExpression(bindTarget))
          return { kind: "opaque", path: bindPath, arguments: undefined };
        // A direct `.bind` on an unprovable owner produces an unprovable
        // bound value; keep the old unresolved classification.
        if (
          virtual === undefined &&
          bound === undefined &&
          captured === undefined &&
          (memberObject === undefined ||
            intrinsicPath(memberObject) === undefined)
        )
          return undefined;
        return {
          kind: "known",
          path: bindPath,
          receiver: bindTarget,
          arguments: arguments_,
        };
      }
      if (method === "call" || method === "apply") {
        const bound: JavaScriptIntrinsicInvocation | undefined =
          memberObject === undefined ? undefined : boundIntrinsic(memberObject);
        // An alias can capture an invocation member read, as in
        // `const invoke = change.call` — its stored value is the member's
        // function. Follow the captured read before giving up on a callable.
        const captured: CapturedInvocationMember | undefined =
          bound === undefined && memberObject !== undefined
            ? memberRead?.(memberObject)
            : undefined;
        if (bound === undefined && captured === undefined) return undefined;
        // A recognized member whose owner slot was overwritten before
        // capture holds an unknown replacement: the call is neither the
        // intrinsic nor effect-free.
        if (captured !== undefined && captured.replaced === true)
          return {
            kind: "opaque",
            path: captured.path,
            arguments: undefined,
          };
        const memberPath: readonly string[] | undefined =
          captured === undefined
            ? undefined
            : intrinsicInvocationMemberPath(captured.key);
        if (explicitReceiver && !t.isExpression(receiver))
          return {
            kind: "opaque",
            path: bound?.path ?? memberPath ?? ["intrinsic"],
            arguments: undefined,
          };
        if (
          bound !== undefined &&
          virtual === undefined &&
          intrinsicReadChanged(memberAt, [...bound.path, method])
        )
          return { kind: "opaque", path: bound.path, arguments: undefined };
        if (
          captured !== undefined &&
          memberPath !== undefined &&
          intrinsicReadChanged(captured.at, memberPath)
        )
          return { kind: "opaque", path: memberPath, arguments: undefined };
        // The alias froze the member's value at its initializer, but the
        // callee reads the member again now: `invoke.call` resolves a new
        // slot on the captured function. A replaced outer member is not
        // the intrinsic, so this call cannot claim a confirmed write.
        const callSitePath: readonly string[] | undefined =
          memberPath === undefined ? undefined : [...memberPath, method];
        if (
          captured !== undefined &&
          callSitePath !== undefined &&
          intrinsicReadChanged(callee, callSitePath)
        )
          return { kind: "opaque", path: callSitePath, arguments: undefined };
        // Function.prototype.call/apply uses the outer explicit receiver
        // as its callable, even when the member was read from a bound value.
        // A captured member is itself that callable: `invoke.call` under an
        // explicit receiver calls the receiver, so substituting the captured
        // owner would erase `Reflect.apply(invoke.call, noop, …)`.
        const callable: t.Node | undefined = explicitReceiver
          ? receiver
          : memberObject;
        if (captured !== undefined && !explicitReceiver) {
          callee = captured.owner;
          virtualMember = { key: captured.key, at: captured.at };
        } else {
          if (!t.isExpression(callable)) return undefined;
          callee = callable;
        }
        receiver = arguments_?.[0];
        explicitReceiver = true;
        arguments_ = invocationArguments(method, arguments_);
        continue;
      }
      const bound = boundIntrinsic(callee);
      if (bound === undefined) {
        // `Reflect.apply(invoke, target, args)` replaces the callee with the
        // bare identifier: it names the captured member itself, not a read
        // on it, and only an explicit receiver makes it callable. A bare
        // `invoke(...)` still invokes the stored member function — with no
        // receiver its effect is unknown, not absent.
        const captured: CapturedInvocationMember | undefined =
          memberRead?.(callee);
        if (captured === undefined) return undefined;
        if (captured.replaced === true)
          return { kind: "opaque", path: captured.path, arguments: undefined };
        if (!explicitReceiver)
          return {
            kind: "opaque",
            path: intrinsicInvocationMemberPath(captured.key),
            arguments: undefined,
          };
        callee = captured.owner;
        virtualMember = { key: captured.key, at: captured.at };
        continue;
      }
      if (bound.kind === "opaque") return bound;
      path = bound.path;
      receiver = bound.receiver;
      explicitReceiver = true;
      arguments_ =
        bound.arguments === undefined || arguments_ === undefined
          ? undefined
          : [...bound.arguments, ...arguments_];
      boundPrefixApplied = bound.arguments !== undefined;
    }
    const method = path.length > 3 ? path.at(-1) : undefined;
    if (method === "bind") {
      const bound = boundIntrinsic(callee);
      if (bound !== undefined)
        return {
          ...bound,
          arguments:
            bound.kind !== "known"
              ? undefined
              : boundPrefixApplied
                ? arguments_
                : bound.arguments === undefined || arguments_ === undefined
                  ? undefined
                  : [...bound.arguments, ...arguments_],
        };
      const callable = explicitReceiver
        ? receiver
        : t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)
          ? callee.object
          : undefined;
      if (!t.isExpression(callable))
        return { kind: "opaque", path, arguments: undefined };
      return {
        kind: "known",
        path: ["intrinsic", "Function", "prototype", "bind"],
        receiver: callable,
        arguments: arguments_,
      };
    }
    if (method === "call" || method === "apply") {
      // These properties hold generic function values. Their receiver selects
      // the callable; property-chain depth does not consume more arguments.
      const callable: t.Node | undefined = explicitReceiver
        ? receiver
        : t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)
          ? callee.object
          : undefined;
      // The callee resolves to an invocation member read but names no
      // callable, as when an identifier aliases `Object.defineProperty.call`
      // and is invoked bare. Such a call throws TypeError when no callable
      // receiver exists, which static analysis cannot prove. An unexamined
      // receiver is unknown effect, neither proof of no write nor a
      // confirmed write.
      if (!t.isExpression(callable))
        return { kind: "opaque", path, arguments: undefined };
      callee = callable;
      receiver = arguments_?.[0];
      explicitReceiver = true;
      arguments_ = invocationArguments(method, arguments_);
      continue;
    }
    if (path.join(".") === "intrinsic.Reflect.apply") {
      const callable = arguments_?.[0];
      if (!t.isExpression(callable)) return undefined;
      callee = callable;
      receiver = arguments_?.[1];
      explicitReceiver = true;
      arguments_ = arrayArguments(arguments_?.[2]);
      continue;
    }
    return {
      kind: "known",
      path,
      arguments: arguments_,
      ...(receiver === undefined ? {} : { receiver }),
    };
  }
};
