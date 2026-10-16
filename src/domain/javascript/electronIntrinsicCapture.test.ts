import { describe, expect, it } from "vitest";
import * as t from "@babel/types";

import { ROLLDOWN_MODULE_INTEROP } from "./javascriptModuleInterop.fixture.js";
import { createSemanticModuleInterop } from "./javascriptModuleInterop.js";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import {
  collectJavaScriptIdentityWritesSteps,
  electronMemberPath,
} from "./javascriptElectronMemberWrites.js";
import { indexJavaScriptBindingsSteps } from "./javascriptSemanticAnalysis.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
} from "./javascriptSemanticTraversal.js";

const CAPTURED_INTEROP = ROLLDOWN_MODULE_INTEROP.replace(
  "__defProp = Object.defineProperty",
  "__defProp = define",
);
const WINDOW = `let electron = require("electron");
  electron = __toESM(electron, 1); new electron.BrowserWindow({});`;

/**
 * Resolve each call in one source through the same interop boundary the
 * identity traversal uses. `kind: "opaque"` means the callee names an
 * intrinsic invocation member read whose callable cannot be determined:
 * unknown effect, neither an effect-free call nor a confirmed write.
 */
const invocationKinds = (source: string) => {
  const parsed = parseJavaScriptSource(source);
  if (parsed === null) throw new Error("invocation fixture did not parse");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(parsed.program),
  );
  const interop = createSemanticModuleInterop(state);
  const invocations: (ReturnType<typeof interop.intrinsicInvocation> | null)[] =
    [];
  traverseJavaScriptAst(parsed.program, {
    enter: (node) => {
      if (t.isCallExpression(node) || t.isOptionalCallExpression(node))
        invocations.push(interop.intrinsicInvocation(node) ?? null);
    },
  });
  return { interop, invocations, parsed };
};

/**
 * Run the real identity-write collection and record each retained write plus
 * each call's invocation classification at the moment it was decided. Writes
 * feed `interop.retainWrite` so later reads observe earlier mutations — the
 * write-free `invocationKinds` helper cannot exercise read timing.
 */
const collectedWrites = (source: string) => {
  const parsed = parseJavaScriptSource(source);
  if (parsed === null) throw new Error("invocation fixture did not parse");
  const state = completeSemanticSteps(
    indexJavaScriptBindingsSteps(parsed.program),
  );
  const interop = createSemanticModuleInterop(state);
  const invocations: (
    | ReturnType<typeof interop.intrinsicInvocation>
    | undefined
  )[] = [];
  const writes: (readonly (string | null)[])[] = [];
  completeSemanticSteps(
    collectJavaScriptIdentityWritesSteps(
      parsed.program,
      (node, kind) => {
        if (kind === "opaque-call") return [interop.opaqueMutationPath(node)];
        // Mirrors the production origin: a member expression naming a
        // captured invocation member resolves to its canonical
        // Function.prototype value identity.
        if (
          kind === "member" &&
          (t.isMemberExpression(node) || t.isOptionalMemberExpression(node))
        ) {
          const capturedValue = interop.capturedInvocationMember(node);
          if (capturedValue !== undefined) {
            return capturedValue.replaced === true
              ? []
              : [["intrinsic", "Function", "prototype", capturedValue.key]];
          }
        }
        const { root, members } = electronMemberPath(node);
        const path =
          interop.intrinsicPath(root) ??
          (kind === "member"
            ? (interop.boundIntrinsic(root)?.path ??
              interop.capturedInvocationMemberPath(root))
            : undefined);
        return path === undefined ? [] : [[...path, ...members]];
      },
      (node) => {
        const invocation = interop.intrinsicInvocation(node);
        invocations.push(invocation);
        return invocation;
      },
      interop.staticString,
      interop.isFreshObject,
      (node, path, kind) => {
        writes.push(path);
        interop.retainWrite(node, path, kind);
      },
      interop.observeEvaluation,
    ),
  );
  return { invocations, writes };
};

describe("captured intrinsic invocation reads", () => {
  it.each([
    '[Object.defineProperty, ignored = Object.defineProperty(metadata,"x",{value:1})] = [replacement];',
    '({first: Object.defineProperty, second: ignored = Object.defineProperty(metadata,"x",{value:1})} = values);',
    '[change.call, ignored = change.call(null,metadata,"x",{value:1})] = [replacement];',
    '({first: change.call, [change.call(null,metadata,"x",{value:1})]: ignored} = values);',
    'for ([change.call, ignored = change.call(null,metadata,"x",{value:1})] of values) {}',
  ])(
    "retains destructuring writes before later defaults and keys: %s",
    (mutation) => {
      const result = analyzeJavaScriptStaticSource(`
      const define = Object.defineProperty;
      const change = define.bind(null);
      const metadata = {}; let ignored;
      ${mutation}
      ${CAPTURED_INTEROP} ${WINDOW}
    `);
      expect(result.electron.browser_windows).toEqual([]);
    },
  );

  it("defers a wrapped default target until after its default runs", () => {
    // `(change.call as any)` unwraps to a pattern leaf, but its write lands
    // only after the default `change.call(...)` runs — the call must stay
    // known so the fresh-target write does not mask a real window.
    const result = analyzeJavaScriptStaticSource(`
      const define = Object.defineProperty;
      const change = define.bind(null);
      const metadata = {};
      [(change.call as any) = change.call(null, metadata, "x", {value: 1})] = [];
      ${CAPTURED_INTEROP} ${WINDOW}
    `);
    expect(result.electron.browser_windows).toHaveLength(1);
  });

  it("evaluates a destructuring RHS before any target writes", () => {
    const result = analyzeJavaScriptStaticSource(`
      const define = Object.defineProperty;
      const metadata = {};
      [Object.defineProperty] = [Object.defineProperty(metadata,"x",{value:1}), replacement];
      ${CAPTURED_INTEROP} ${WINDOW}
    `);
    expect(result.electron.browser_windows).toHaveLength(1);
  });

  it("evaluates assignment operands before recording their writes", () => {
    const result = analyzeJavaScriptStaticSource(`
      const define = Object.defineProperty;
      const metadata = {};
      Object.defineProperty = (Object.defineProperty(metadata, "x", {value:1}), replacement);
      ${CAPTURED_INTEROP} ${WINDOW}
    `);
    expect(result.electron.browser_windows).toHaveLength(1);
  });

  it("retains whole-object mutations at a captured function's later member read", () => {
    const result = analyzeJavaScriptStaticSource(`
      const define = Object.defineProperty;
      Object.assign(define, {call: replacement});
      const metadata = {}; define.call(null, metadata, "x", {value:1});
      ${CAPTURED_INTEROP} ${WINDOW}
    `);
    expect(result.electron.browser_windows).toEqual([]);
  });

  it("retains callee-prefix effects before classifying the invocation", () => {
    const result = analyzeJavaScriptStaticSource(`
      const define = Object.defineProperty;
      const metadata = {};
      (Object.defineProperty = replacement, Object.defineProperty)(metadata,"x",{value:1});
      ${CAPTURED_INTEROP} ${WINDOW}
    `);
    expect(result.electron.browser_windows).toEqual([]);
  });

  it("retains a callee selected before an argument replaces its global property", () => {
    const result = analyzeJavaScriptStaticSource(`
      const define = Object.defineProperty;
      const metadata = {};
      Object.defineProperty(metadata,"x",(Object.defineProperty = replacement,{value:1}));
      ${CAPTURED_INTEROP} ${WINDOW}
    `);
    expect(result.electron.browser_windows).toHaveLength(1);
  });

  it.each([
    'define.call(null,metadata,"x",{value:1});',
    'define.apply(null,[metadata,"x",{value:1}]);',
    'const change = define.bind(null,metadata,"x"); change({value:1});',
    'const also = define; also.call(null,metadata,"x",{value:1});',
  ])("retains a function captured before global replacement: %s", (invoke) => {
    const result = analyzeJavaScriptStaticSource(`
      const define = Object.defineProperty;
      Object.defineProperty = replacement;
      const metadata = {}; ${invoke}
      ${CAPTURED_INTEROP} ${WINDOW}
    `);
    expect(result.electron.browser_windows).toHaveLength(1);
  });

  it.each([
    ["call", 'define.call(null,metadata,"x",{value:1});'],
    ["apply", 'define.apply(null,[metadata,"x",{value:1}]);'],
    [
      "bind",
      'const change = define.bind(null,metadata,"x"); change({value:1});',
    ],
  ])(
    "checks the later %s property read on a captured function",
    (method, invoke) => {
      for (const owner of ["define", "Function.prototype"]) {
        const result = analyzeJavaScriptStaticSource(`
        const define = Object.defineProperty;
        ${owner}.${method} = replacement;
        const metadata = {}; ${invoke}
        ${CAPTURED_INTEROP} ${WINDOW}
      `);
        expect(result.electron.browser_windows, owner).toEqual([]);
      }
    },
  );
});

describe("identifier-aliased intrinsic invocation members", () => {
  it.each(["call", "apply"])(
    "preserves a detached bound %s member's explicit receiver",
    (method) => {
      const source = `const change = Object.defineProperty.bind(null,Object,"create");
      const noop = () => {}; Reflect.apply(change.${method}, noop,
      [null, ${method === "apply" ? "[{value:customCreate}]" : "{value:customCreate}"}]);`;
      expect(invocationKinds(source).invocations).not.toContainEqual(
        expect.objectContaining({
          kind: "known",
          path: ["intrinsic", "Object", "defineProperty"],
        }),
      );
      const result = analyzeJavaScriptStaticSource(
        `${source}\n${ROLLDOWN_MODULE_INTEROP}\n${WINDOW}`,
      );
      expect(result.electron.browser_windows).not.toEqual([]);
    },
  );

  it.each(["call", "apply"])(
    "keeps a detached bound %s member opaque",
    (method) => {
      const source = `const change = Object.defineProperty.bind(null,Object,"create");
      (0, change.${method})(null, ${method === "apply" ? "[{value:customCreate}]" : "{value:customCreate}"});`;
      expect(invocationKinds(source).invocations.at(-1)).toMatchObject({
        kind: "opaque",
        arguments: undefined,
      });
    },
  );

  it("models the write while the captured member's later read is unchanged", () => {
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      const invoke = change.call;
      invoke.call(change,null,{value:customCreate});`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({
        kind: "known",
        path: ["intrinsic", "Object", "defineProperty"],
      }),
    );
    expect(writes).toContainEqual(["intrinsic", "Object", "create"]);
  });

  it.each([
    ["call", "invoke.call(change,null,{value:customCreate});"],
    ["apply", "invoke.apply(change,[null,{value:customCreate}]);"],
  ])(
    "does not claim the intrinsic when Function.prototype.call.%s is replaced",
    (member, invoke) => {
      // `invoke` captured Function.prototype.call at its initializer, but
      // `invoke.call` is a fresh property read at the call site: after
      // `Function.prototype.call.call` is replaced the invoked value is the
      // replacement, so no confirmed defineProperty write exists.
      const { invocations, writes } = collectedWrites(
        `const change = Object.defineProperty.bind(null,Object,"create");
        const invoke = change.call;
        Function.prototype.call.${member} = replacement;
        ${invoke}`,
      );
      expect(invocations.at(-1)).toEqual(
        expect.objectContaining({ kind: "opaque" }),
      );
      expect(writes).not.toContainEqual(["intrinsic", "Object", "create"]);
      expect(writes).toContainEqual(["intrinsic"]);
    },
  );

  it.each([
    ["call", "invoke.call(change,null,{value:customCreate});"],
    ["apply", "invoke.apply(change,[null,{value:customCreate}]);"],
  ])(
    "reads a member replaced through the captured function's alias: %s",
    (member, invoke) => {
      // `invoke` IS Function.prototype.call, so `invoke.${member}` names the
      // same property slot as `Function.prototype.call.${member}` — a write
      // through the alias must reach the captured-member identity the read
      // side checks.
      const { invocations, writes } = collectedWrites(
        `const change = Object.defineProperty.bind(null,Object,"create");
        const invoke = change.call;
        invoke.${member} = replacement;
        ${invoke}`,
      );
      expect(writes).toContainEqual([
        "intrinsic",
        "Function",
        "prototype",
        "call",
        member,
      ]);
      expect(invocations.at(-1)).toEqual(
        expect.objectContaining({ kind: "opaque" }),
      );
      expect(writes).not.toContainEqual(["intrinsic", "Object", "create"]);
    },
  );

  it("retains argument effects when the outer member read is replaced", () => {
    // The argument's own write is recorded even though the replaced outer
    // member makes the invocation itself unknown.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      const invoke = change.call;
      Function.prototype.call.call = replacement;
      invoke.call(change,null,(Object.create = customCreate, {value:1}));`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({ kind: "opaque" }),
    );
    expect(
      writes.filter(
        (path) =>
          path.length === 3 &&
          path[0] === "intrinsic" &&
          path[1] === "Object" &&
          path[2] === "create",
      ),
    ).toHaveLength(1);
  });

  it.each([
    'const change = Object.defineProperty.call; change(null,Object,"create",{value:customCreate});',
    'const {apply:change} = Object.defineProperty; change(null,[Object,"create",{value:customCreate}]);',
    'const change = Reflect.apply.call; change(null,Object.defineProperty,null,[Object,"create",{value:customCreate}]);',
  ])(
    "keeps a bare invocation member alias unknown, not effect-free: %s",
    (source) => {
      // `change` IS Function.prototype.call/apply read through an intrinsic.
      // Invoked bare it has no callable receiver, so a real engine throws
      // TypeError and no property write runs. Static analysis cannot prove
      // that receiver, so the invocation stays unknown rather than either
      // an effect-free call or a confirmed write.
      expect(invocationKinds(source).invocations).toEqual([
        expect.objectContaining({ kind: "opaque" }),
      ]);
      const result = analyzeJavaScriptStaticSource(
        `${source}\n${ROLLDOWN_MODULE_INTEROP}\n${WINDOW}`,
      );
      expect(result.electron.browser_windows).toEqual([]);
    },
  );

  it.each([
    'const change = Object.defineProperty.call; change.call(Object.defineProperty,null,Object,"create",{value:customCreate});',
    'Function.prototype.call.call(Object.defineProperty,null,Object,"create",{value:customCreate});',
    '(0, Object.defineProperty)(Object,"create",{value:customCreate});',
  ])("resolves an invocation that names a callable receiver: %s", (source) => {
    // Same invocation member reads, but the callable receiver is named.
    // These resolve to a known defineProperty write on Object.create.
    expect(invocationKinds(source).invocations).toEqual([
      expect.objectContaining({
        kind: "known",
        path: ["intrinsic", "Object", "defineProperty"],
      }),
    ]);
    const result = analyzeJavaScriptStaticSource(
      `${source}\n${ROLLDOWN_MODULE_INTEROP}\n${WINDOW}`,
    );
    expect(result.electron.browser_windows).toEqual([]);
  });

  it.each([
    '(0, Object.defineProperty.call)(null,metadata,"x",{value:1});',
    '(0, Object.defineProperty.apply)(null,[metadata,"x",{value:1}]);',
  ])("does not reconstruct a receiver erased by a sequence: %s", (source) => {
    expect(
      invocationKinds(`const metadata = {}; ${source}`).invocations,
    ).toEqual([expect.objectContaining({ kind: "opaque" })]);
  });
});

describe("captured invocation member identity", () => {
  it("does not attribute a custom member alias to the intrinsic member", () => {
    // `local` is the custom arrow function, not Function.prototype.call —
    // writing through it must not reach the canonical member identity, or a
    // later legitimate `Function.prototype.call.call` would turn opaque.
    const { invocations, writes } = collectedWrites(
      `const custom = {call: () => {}};
      const local = custom.call;
      local.call = () => {};
      const metadata = {};
      Function.prototype.call.call(Object.defineProperty,null,metadata,"x",{value:1});`,
    );
    expect(writes).not.toContainEqual([
      "intrinsic",
      "Function",
      "prototype",
      "call",
      "call",
    ]);
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({
        kind: "known",
        path: ["intrinsic", "Object", "defineProperty"],
      }),
    );
    const result = analyzeJavaScriptStaticSource(
      `const define = Object.defineProperty;
      const custom = {call: () => {}};
      const local = custom.call;
      local.call = () => {};
      ${CAPTURED_INTEROP} ${WINDOW}`,
    );
    expect(result.electron.browser_windows).toHaveLength(1);
  });

  it("rejects a captured member read replaced on its owner", () => {
    // `change.call` is overwritten before capture, so `invoke` holds the
    // replacement object — not Function.prototype.call — and the reflect
    // call invokes `noop`, never the bound defineProperty. The member shape
    // is recognized but the callable is unknown, so the call is opaque.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      change.call = {call: noop};
      const invoke = change.call;
      Reflect.apply(invoke.call, change, [null, {value: customCreate}]);`,
    );
    expect(writes).not.toContainEqual(["intrinsic", "Object", "create"]);
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({ kind: "opaque" }),
    );
    expect(writes).toContainEqual(["intrinsic"]);
  });

  it("keeps a replaced captured member's call effect opaque", () => {
    // `invoke` stores the replacement arrow, which runs and assigns
    // `Object.create` when invoked. Rejecting the intrinsic identity must not
    // drop the call's effect: recognized member shape plus an unknown
    // callable means opaque, so the unknown effect is retained and a later
    // helper cannot read a trusted intrinsic namespace.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      change.call = () => { Object.create = customCreate; };
      const invoke = change.call;
      invoke.call(change,null,{value:customCreate});`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({ kind: "opaque" }),
    );
    expect(writes).toContainEqual(["intrinsic"]);
  });

  it("resolves a captured member passed directly to Reflect.apply", () => {
    // `invoke` IS Function.prototype.call, so `Reflect.apply(invoke, change,
    // args)` runs `change(...args)` — the bound defineProperty writes
    // `Object.create` exactly as `invoke.call(change, ...)` would.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      const invoke = change.call;
      Reflect.apply(invoke, change, [null, {value: customCreate}]);`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({
        kind: "known",
        path: ["intrinsic", "Object", "defineProperty"],
      }),
    );
    expect(writes).toContainEqual(["intrinsic", "Object", "create"]);
  });

  it("keeps a replaced captured member opaque as a Reflect.apply target", () => {
    // `invoke` holds the replacement, so `Reflect.apply(invoke, ...)` calls an
    // unknown function: opaque, never a confirmed defineProperty write.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      change.call = () => {};
      const invoke = change.call;
      Reflect.apply(invoke, change, [null, {value: customCreate}]);`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({ kind: "opaque" }),
    );
    expect(writes).not.toContainEqual(["intrinsic", "Object", "create"]);
    expect(writes).toContainEqual(["intrinsic"]);
  });

  it("follows a sequence tail in a captured-member alias", () => {
    // `(0, change.call)` stores the tail member read, so `invoke` holds
    // Function.prototype.call and the call writes `Object.create`.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      const invoke = (0, change.call);
      invoke.call(change,null,{value:customCreate});`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({
        kind: "known",
        path: ["intrinsic", "Object", "defineProperty"],
      }),
    );
    expect(writes).toContainEqual(["intrinsic", "Object", "create"]);
  });
});

describe("extended captured invocation member resolution", () => {
  it("keeps a bare call of a replaced captured member opaque", () => {
    // `invoke` stores the replacement arrow — `invoke()` runs it, so the
    // call has an unknown effect, not no effect at all.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      change.call = () => { Object.create = customCreate; };
      const invoke = change.call;
      invoke();`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({ kind: "opaque" }),
    );
    expect(writes).toContainEqual(["intrinsic"]);
  });

  it("follows a destructured captured-member alias", () => {
    // `const {call: invoke} = change` stores the projected member read —
    // invoke is Function.prototype.call, so the call writes Object.create.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      const {call: invoke} = change;
      invoke.call(change,null,{value:customCreate});`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({
        kind: "known",
        path: ["intrinsic", "Object", "defineProperty"],
      }),
    );
    expect(writes).toContainEqual(["intrinsic", "Object", "create"]);
  });

  it("preserves the explicit receiver of a captured member call", () => {
    // `invoke.call` resolves to Function.prototype.call, so
    // `Reflect.apply(invoke.call, noop, [change, …])` calls noop — the
    // captured owner must not replace the explicit receiver as callable.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      const invoke = change.call;
      const noop = () => {};
      Reflect.apply(invoke.call, noop, [change, null, {value: customCreate}]);`,
    );
    expect(invocations.at(-1)).not.toEqual(
      expect.objectContaining({ kind: "known" }),
    );
    expect(writes).not.toContainEqual(["intrinsic", "Object", "create"]);
  });

  it("detects a member replaced before a destructured capture", () => {
    // `change.call` is overwritten before `const {call: invoke} = change`
    // reads it — invoke stores the replacement, so the call is opaque.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      change.call = () => {};
      const {call: invoke} = change;
      invoke.call(change, null, {value: customCreate});`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({ kind: "opaque" }),
    );
    expect(writes).not.toContainEqual(["intrinsic", "Object", "create"]);
  });

  it("follows a captured member through a nested owner read", () => {
    // `outer = invoke.call` reads .call off the captured FP.call — the
    // chain still resolves to the bound defineProperty write.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      const invoke = change.call;
      const outer = invoke.call;
      outer.call(invoke, change, null, {value: customCreate});`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({
        kind: "known",
        path: ["intrinsic", "Object", "defineProperty"],
      }),
    );
    expect(writes).toContainEqual(["intrinsic", "Object", "create"]);
  });
});

describe("captured member canonicalization and timing", () => {
  it("canonicalizes a write through a captured invocation member", () => {
    // `change.call` reads Function.prototype.call, so writing `.call` on it
    // lands on `intrinsic.Function.prototype.call.call` — the same slot the
    // call-site member re-read checks. The later call must see the replace.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      change.call.call = () => {};
      const invoke = change.call;
      invoke.call(change, null, {value: customCreate});`,
    );
    expect(writes).toContainEqual([
      "intrinsic",
      "Function",
      "prototype",
      "call",
      "call",
    ]);
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({ kind: "opaque" }),
    );
    expect(writes).not.toContainEqual(["intrinsic", "Object", "create"]);
  });

  it("resolves a captured bind member to a bound invocation", () => {
    // `rebinder = change.bind` stores Function.prototype.bind; calling it on
    // `change` produces the same bound callable `change` already is, so the
    // follow-up call still writes Object.create.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      const rebinder = change.bind;
      const changed = rebinder.call(change, null);
      changed({value: customCreate});`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({
        kind: "known",
        path: ["intrinsic", "Object", "defineProperty"],
      }),
    );
    expect(writes).toContainEqual(["intrinsic", "Object", "create"]);
  });

  it("unwraps a sequence supplying a member owner", () => {
    // `(0, change)` evaluates to `change`, so the member call still invokes
    // the bound defineProperty.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      (0, change).call(null, {value: customCreate});`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({
        kind: "known",
        path: ["intrinsic", "Object", "defineProperty"],
      }),
    );
    expect(writes).toContainEqual(["intrinsic", "Object", "create"]);
  });

  it("re-enters a captured alias with a different invocation state", () => {
    // `invoke.call(invoke, change, …)` visits `invoke` twice with distinct
    // receiver/argument states — both transitions are legitimate and the
    // bound write must still resolve.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      const invoke = change.call;
      invoke.call(invoke, change, null, {value: customCreate});`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({
        kind: "known",
        path: ["intrinsic", "Object", "defineProperty"],
      }),
    );
    expect(writes).toContainEqual(["intrinsic", "Object", "create"]);
  });

  it("resolves a nested invocation member of a bound callable", () => {
    // `change.call.call` reads `.call` on Function.prototype.call itself —
    // Function.prototype.call again — so the call reaches defineProperty.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      change.call.call(change, null, {value: customCreate});`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({
        kind: "known",
        path: ["intrinsic", "Object", "defineProperty"],
      }),
    );
    expect(writes).toContainEqual(["intrinsic", "Object", "create"]);
  });

  it("times a destructured capture at the projected property read", () => {
    // The `missing` property's default runs before `call` is read and
    // overwrites `change.call` — `invoke` stores the replacement, so the
    // call is opaque, not the bound defineProperty.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      const noop = () => {};
      const {missing: x = (change.call = noop), call: invoke} = change;
      invoke.call(change, null, {value: customCreate});`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({ kind: "opaque" }),
    );
    expect(writes).not.toContainEqual(["intrinsic", "Object", "create"]);
  });

  it("preserves the explicit receiver of a direct bind member", () => {
    // `Reflect.apply(change.bind, Object.defineProperty, […])` invokes
    // Function.prototype.bind with Object.defineProperty as its receiver —
    // `decorate` binds defineProperty onto `metadata`, never `change`'s
    // bound create write.
    const { invocations, writes } = collectedWrites(
      `const metadata = {};
      const change = Object.defineProperty.bind(null,Object,"create");
      const decorate = Reflect.apply(change.bind, Object.defineProperty, [null, metadata, "x"]);
      decorate({value: 1});`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({
        kind: "known",
        path: ["intrinsic", "Object", "defineProperty"],
      }),
    );
    expect(writes).not.toContainEqual(["intrinsic", "Object", "create"]);
  });
});

describe("captured member nested owners and projections", () => {
  it("propagates replaced state through a nested captured owner", () => {
    // `invoke` stores the replaced `{call: poison}` object, so `outer =
    // invoke.call` captures `poison` — `outer()` executes it and must stay
    // opaque rather than effect-free.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      const poison = () => { Object.create = customCreate; };
      change.call = {call: poison};
      const invoke = change.call;
      const outer = invoke.call;
      outer();`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({ kind: "opaque" }),
    );
    expect(writes).toContainEqual(["intrinsic"]);
    // The poison body's own write is a static fact — opaque means unknown,
    // not absent.
    expect(writes).toContainEqual(["intrinsic", "Object", "create"]);
  });

  it("carries a captured member value through a direct bind", () => {
    // `invoke.bind(change, null)` binds Function.prototype.call itself —
    // `changed(x)` is `change(x)` with this null, still reaching the bound
    // defineProperty write.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      const invoke = change.call;
      const changed = invoke.bind(change, null);
      changed({value: customCreate});`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({
        kind: "known",
        path: ["intrinsic", "Object", "defineProperty"],
      }),
    );
    expect(writes).toContainEqual(["intrinsic", "Object", "create"]);
  });

  it("follows a multi-segment destructured member capture", () => {
    // `{call: {call: invoke}}` reads `call` on `change`, then `call` on the
    // result — Function.prototype.call both times — so the call reaches
    // the bound defineProperty.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      const {call: {call: invoke}} = change;
      invoke.call(change, null, {value: customCreate});`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({
        kind: "known",
        path: ["intrinsic", "Object", "defineProperty"],
      }),
    );
    expect(writes).toContainEqual(["intrinsic", "Object", "create"]);
  });

  it("times a destructured capture at its own duplicate-key read", () => {
    // `call` appears twice: `first` reads the intact member, then the
    // `missing` default overwrites it, so the second read stores `noop` in
    // `invoke` — matching by binding name must select the later leaf.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      const noop = () => {};
      const {call: first, missing: x = (change.call = noop), call: invoke} = change;
      invoke.call(change, null, {value: customCreate});`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({ kind: "opaque" }),
    );
    expect(writes).not.toContainEqual(["intrinsic", "Object", "create"]);
  });

  it("checks the recorded bind read on a captured-member bind chain", () => {
    // `invoke.bind = …` shadows Function.prototype.bind on the captured
    // member, so `changed` is the replacement's no-op — not bound call.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      const invoke = change.call;
      invoke.bind = () => () => {};
      const changed = invoke.bind(change, null);
      changed({value: customCreate});`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({ kind: "opaque" }),
    );
    expect(writes).not.toContainEqual(["intrinsic", "Object", "create"]);
  });

  it("checks the inherited member slot at every projected level", () => {
    // `Function.prototype.call = {apply: noop}` replaces the value the
    // outer `.call` read captures — `invoke` is the no-op, not apply.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      Function.prototype.call = {apply: () => {}};
      const {call: {apply: invoke}} = change;
      Reflect.apply(invoke, change, [null, [{value: customCreate}]]);`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({ kind: "opaque" }),
    );
    expect(writes).not.toContainEqual(["intrinsic", "Object", "create"]);
  });

  it("times each projected level at its own property read", () => {
    // The outer `.call` is read before the `missing` default replaces
    // `change.call`, so `invoke` still holds Function.prototype.call and
    // the final call writes only through the bound defineProperty.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null);
      const metadata = {};
      const {call: {missing: x = (change.call = () => {}), call: invoke}} = change;
      invoke.call(change, null, metadata, "x", {value: 1});`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({
        kind: "known",
        path: ["intrinsic", "Object", "defineProperty"],
      }),
    );
  });
});

describe("captured invocation member identity", () => {
  it("follows a copied captured-member alias", () => {
    // `copy` is a second stable alias of the captured member; the call still
    // reaches the bound defineProperty and must keep its write.
    const { invocations, writes } = collectedWrites(
      `const change = Object.defineProperty.bind(null,Object,"create");
      const invoke = change.call;
      const copy = invoke;
      copy.call(change,null,{value:customCreate});`,
    );
    expect(invocations.at(-1)).toEqual(
      expect.objectContaining({
        kind: "known",
        path: ["intrinsic", "Object", "defineProperty"],
      }),
    );
    expect(writes).toContainEqual(["intrinsic", "Object", "create"]);
  });
});

describe("intrinsic invocation member effects", () => {
  it("retains a converted Electron window evaluated inside an opaque invocation's arguments", () => {
    const result = analyzeJavaScriptStaticSource(`
      ${ROLLDOWN_MODULE_INTEROP}
      const change = Object.defineProperty.call;
      change(null, Object, "x", {value: new (__toESM(require("electron"), 1)).BrowserWindow({})});
    `);
    expect(result.electron.browser_windows).toHaveLength(1);
  });

  it("preserves a captured base through an invocation alias after global replacement", () => {
    const result = analyzeJavaScriptStaticSource(`
      const define = Object.defineProperty;
      Object.defineProperty = replacement;
      const change = define.call;
      const metadata = {}; change.call(define,null,metadata,"x",{value:1});
      ${CAPTURED_INTEROP} ${WINDOW}
    `);
    expect(result.electron.browser_windows).toHaveLength(1);
  });

  it("limits a known invocation effect to its fresh target", () => {
    const source =
      'const metadata = {}; Object.defineProperty.call(null,metadata,"x",{value:1});';
    expect(invocationKinds(source).invocations).toEqual([
      expect.objectContaining({
        kind: "known",
        path: ["intrinsic", "Object", "defineProperty"],
      }),
    ]);
    const result = analyzeJavaScriptStaticSource(
      `${source}\n${ROLLDOWN_MODULE_INTEROP}\n${WINDOW}`,
    );
    expect(result.electron.browser_windows).toHaveLength(1);
  });

  it("keeps a replaced invocation member read unknown", () => {
    const source = `Object.defineProperty.call = replacement;
      const change = Object.defineProperty.call;
      change.call(Object.defineProperty,null,Object,"create",{value:customCreate});`;
    const { interop, invocations, parsed } = invocationKinds(source);
    // Before the visible member write is retained the same call names a
    // callable receiver and resolves to a known defineProperty invocation.
    expect(invocations).toEqual([
      expect.objectContaining({
        kind: "known",
        path: ["intrinsic", "Object", "defineProperty"],
      }),
    ]);
    // Retaining the member write marks the captured read changed: the alias
    // can hold the replacement, so the same call stays unknown.
    let replaced = false;
    traverseJavaScriptAst(parsed.program, {
      enter: (node) => {
        if (
          !replaced &&
          t.isAssignmentExpression(node) &&
          t.isMemberExpression(node.left) &&
          t.isIdentifier(node.left.property, { name: "call" })
        ) {
          interop.retainWrite(node, [
            "intrinsic",
            "Object",
            "defineProperty",
            "call",
          ]);
          replaced = true;
        }
      },
    });
    expect(replaced).toBe(true);
    const call = parsed.program.body
      .filter(t.isExpressionStatement)
      .map((statement) => statement.expression)
      .find(
        (expression): expression is t.CallExpression =>
          t.isCallExpression(expression) &&
          t.isMemberExpression(expression.callee),
      );
    expect(interop.intrinsicInvocation(call!)).toEqual(
      expect.objectContaining({ kind: "opaque" }),
    );
    const result = analyzeJavaScriptStaticSource(
      `${source}\n${ROLLDOWN_MODULE_INTEROP}\n${WINDOW}`,
    );
    expect(result.electron.browser_windows).toEqual([]);
  });

  it.each([
    'const change = Object.defineProperty.call; change((Object.create = replacement, null),Object,"create",{value:customCreate});',
    'const {apply:change} = Object.defineProperty; change(null,[(Object.defineProperty = replacement, Object),"create",{value:customCreate}]);',
  ])(
    "records argument effects before an unknown invocation throws: %s",
    (source) => {
      // A real engine evaluates the arguments first: the intrinsic write in
      // the argument runs even though the bare alias call then throws. The
      // argument effect must be retained alongside the unknown call effect.
      expect(invocationKinds(source).invocations).toEqual([
        expect.objectContaining({ kind: "opaque" }),
      ]);
      const result = analyzeJavaScriptStaticSource(
        `${source}\n${ROLLDOWN_MODULE_INTEROP}\n${WINDOW}`,
      );
      expect(result.electron.browser_windows).toEqual([]);
    },
  );

  it("examines findings inside an opaque invocation argument", () => {
    const result = analyzeJavaScriptStaticSource(`
      const change = Object.defineProperty.call;
      change(null,Object,"create",{value:new (require("electron").BrowserWindow)({})});
    `);
    expect(result.electron.browser_windows).toHaveLength(1);
  });
});
