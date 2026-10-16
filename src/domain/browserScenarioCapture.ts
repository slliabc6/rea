import { z } from "zod";
import {
  browserNetworkContentSelectionValuesSchema,
  browserNetworkContentUnavailable,
} from "./browserNetworkEvidence.js";
import { browserScenarioCaptureLimitsValuesSchema } from "./browserScenarioCaptureLimits.js";

import {
  BROWSER_SCENARIO_POPUP_GAP_FAMILIES,
  BROWSER_SCENARIO_START_STEP,
  browserScenarioCompletenessSchema,
  browserScenarioEventFamilySchema,
  browserScenarioEventKindFamily,
  browserScenarioEventOmissionsSchema,
  browserScenarioEventSchema,
  browserScenarioOmissionKindSelected,
  browserScenarioStepSchema,
  classifyBrowserScenarioCompleteness,
  deriveStepCompleteness,
  enabledScenarioEventFamilies,
  sameCompletenessSections,
  type BrowserScenarioCompletenessSection,
  type BrowserScenarioEventBudgetReason,
  type BrowserScenarioEventKind,
} from "./browserScenarioCaptureValues.js";

const capturedFieldsSchema = z.strictObject({
  browser: z.strictObject({
    mode: z.enum(["launch", "connect"]),
    process_ownership: z.enum(["provider-owned", "external"]),
    cleanup: z.enum(["terminated-owned-process", "disconnected-external"]),
    product: z.string().min(1),
    version: z.string().min(1),
  }),
  scenario: z.strictObject({
    start_origin: z.string().min(1),
    action_count: z.number().int().min(1),
    secret_references: z.array(z.string().min(1)),
    network_content: browserNetworkContentSelectionValuesSchema,
    event_families: z.array(browserScenarioEventFamilySchema),
    limits: browserScenarioCaptureLimitsValuesSchema,
  }),
  duration_ms: z.number().int().min(0),
  steps: z.array(browserScenarioStepSchema).min(1),
  events: z.strictObject({
    retained: z.number().int().min(0),
    dropped: z.number().int().min(0),
    items: z.array(browserScenarioEventSchema),
    omissions: browserScenarioEventOmissionsSchema,
  }),
  completeness: browserScenarioCompletenessSchema,
  limitations: z.array(z.string().min(1)),
});
type CapturedFields = z.infer<typeof capturedFieldsSchema>;

/**
 * Retained events belong only to families the scenario selected; omission
 * accounting follows the producer's admission rule for selected families, and
 * only the network collector accounts network transaction omissions.
 */
const refineSelectedEventFamilies = (
  { scenario, events }: CapturedFields,
  context: z.RefinementCtx,
): void => {
  const selected = new Set(
    enabledScenarioEventFamilies(
      scenario.event_families,
      scenario.network_content,
    ),
  );
  const unselected = (
    kind: BrowserScenarioEventKind,
    path: readonly (string | number)[],
  ): void => {
    context.addIssue({
      code: "custom",
      path: [...path],
      message: `Event kind ${kind} belongs to the ${browserScenarioEventKindFamily(kind)} family, which the scenario did not select`,
    });
  };
  for (const [index, { kind }] of events.items.entries())
    if (!selected.has(browserScenarioEventKindFamily(kind)))
      unselected(kind, ["events", "items", index, "kind"]);
  for (const [index, { kind }] of events.omissions.by_kind.entries())
    if (!browserScenarioOmissionKindSelected(kind, selected))
      unselected(kind, ["events", "omissions", "by_kind", index, "kind"]);
  const networkSelected = selected.has("network");
  const networkOmission = (path: readonly (string | number)[]): void => {
    context.addIssue({
      code: "custom",
      path: [...path],
      message:
        "Network transaction omissions require the network family, which the scenario did not select",
    });
  };
  for (const [
    index,
    omission,
  ] of events.omissions.network_transactions.entries()) {
    const path = ["events", "omissions", "network_transactions", index];
    if (!networkSelected) {
      networkOmission(path);
      continue;
    }
    for (const [kindIndex, kind] of omission.omitted_kinds.entries())
      if (browserScenarioEventKindFamily(kind) !== "network")
        context.addIssue({
          code: "custom",
          path: [...path, "omitted_kinds", kindIndex],
          message: `Network transaction omissions name only network event kinds; ${kind} belongs to the ${browserScenarioEventKindFamily(kind)} family`,
        });
  }
  if (events.omissions.network_transaction_range !== null && !networkSelected)
    networkOmission(["events", "omissions", "network_transaction_range"]);
};

/** Step 0 is always the producer's completed implicit start navigation. */
const refineStartStep = (
  { steps }: CapturedFields,
  context: z.RefinementCtx,
): void => {
  const start = steps[0];
  if (
    start !== undefined &&
    (start.step_id !== BROWSER_SCENARIO_START_STEP.step_id ||
      start.action !== BROWSER_SCENARIO_START_STEP.action ||
      start.status !== "completed")
  )
    context.addIssue({
      code: "custom",
      path: ["steps", 0],
      message: `Step 0 must be the completed implicit start navigation (step_id ${BROWSER_SCENARIO_START_STEP.step_id}, action ${BROWSER_SCENARIO_START_STEP.action})`,
    });
  // Later windows rise from here, so every receipt belongs to a window or follows one.
  if (
    start !== undefined &&
    start.event_sequence_start !==
      BROWSER_SCENARIO_START_STEP.event_sequence_start
  )
    context.addIssue({
      code: "custom",
      path: ["steps", 0, "event_sequence_start"],
      message: `Step 0's receipt window starts at event sequence ${String(BROWSER_SCENARIO_START_STEP.event_sequence_start)}`,
    });
};

const BROWSER_IDENTITIES = {
  launch: {
    process_ownership: "provider-owned",
    cleanup: "terminated-owned-process",
  },
  connect: { process_ownership: "external", cleanup: "disconnected-external" },
} as const;

/** Launch owns and terminates its browser; connect attaches to and disconnects from one. */
const refineBrowserIdentity = (
  { browser }: CapturedFields,
  context: z.RefinementCtx,
): void => {
  const expected = BROWSER_IDENTITIES[browser.mode];
  if (
    browser.process_ownership !== expected.process_ownership ||
    browser.cleanup !== expected.cleanup
  )
    context.addIssue({
      code: "custom",
      path: ["browser"],
      message: `A ${browser.mode} capture records process_ownership ${expected.process_ownership} and cleanup ${expected.cleanup}`,
    });
};

/** Without network the family rule already rejects network omission records. */
const networkSelected = ({ scenario }: CapturedFields): boolean =>
  enabledScenarioEventFamilies(
    scenario.event_families,
    scenario.network_content,
  ).includes("network");

/**
 * Only transactions refused by max-network-transactions fill the omitted
 * range, and each refused transaction drops at least one of its events.
 */
const refineTransactionRange = (
  capture: CapturedFields,
  context: z.RefinementCtx,
): void => {
  if (!networkSelected(capture)) return;
  const { omissions } = capture.events;
  const range = omissions.network_transaction_range;
  const refusedDrops = omissions.by_kind
    .filter(({ reasons }) => reasons.includes("max-network-transactions"))
    .reduce((count, omission) => count + omission.count, 0);
  if (range === null ? refusedDrops > 0 : refusedDrops < range.count)
    context.addIssue({
      code: "custom",
      path: ["events", "omissions", "network_transaction_range"],
      message:
        range === null
          ? "Events dropped for max-network-transactions require the omitted transaction range"
          : "Each transaction in the omitted range drops at least one event for max-network-transactions",
    });
};

/** Admitted transactions are omitted for any budget except the range's own. */
const transactionOmissionReason = (
  reason: BrowserScenarioEventBudgetReason,
): boolean => reason !== "max-network-transactions";

/**
 * An admitted transaction names an omitted kind and reason only after that
 * event was dropped for that reason, so each per-transaction omission is
 * backed by by_kind, and every budget drop of a network kind names its
 * transaction. Refused transactions belong to the omitted range instead.
 */
const refineTransactionOmissions = (
  capture: CapturedFields,
  context: z.RefinementCtx,
): void => {
  if (!networkSelected(capture)) return;
  const { by_kind: byKind, network_transactions: transactions } =
    capture.events.omissions;
  const dropped = new Map(byKind.map((omission) => [omission.kind, omission]));
  const transactionsByKind = new Map<BrowserScenarioEventKind, number>();
  for (const [index, omission] of transactions.entries()) {
    // The family rule reports non-network kinds.
    if (
      omission.omitted_kinds.some(
        (kind) => browserScenarioEventKindFamily(kind) !== "network",
      )
    )
      continue;
    for (const kind of new Set(omission.omitted_kinds))
      transactionsByKind.set(kind, (transactionsByKind.get(kind) ?? 0) + 1);
    const backed =
      omission.omitted_kinds.every((kind) => dropped.has(kind)) &&
      omission.reasons.every(
        (reason) =>
          transactionOmissionReason(reason) &&
          omission.omitted_kinds.some((kind) =>
            dropped.get(kind)?.reasons.includes(reason),
          ),
      );
    if (!backed)
      context.addIssue({
        code: "custom",
        path: ["events", "omissions", "network_transactions", index],
        message:
          "Each omitted transaction kind and budget reason must be dropped in by_kind",
      });
  }
  for (const [index, omission] of byKind.entries()) {
    if (browserScenarioEventKindFamily(omission.kind) !== "network") continue;
    const unnamed = omission.reasons.filter(
      (reason) =>
        transactionOmissionReason(reason) &&
        !transactions.some(
          (transaction) =>
            transaction.omitted_kinds.includes(omission.kind) &&
            transaction.reasons.includes(reason),
        ),
    );
    const named = transactionsByKind.get(omission.kind) ?? 0;
    if (unnamed.length > 0 || named > omission.count)
      context.addIssue({
        code: "custom",
        path: ["events", "omissions", "by_kind", index],
        message:
          unnamed.length > 0
            ? `${omission.kind} events dropped for ${unnamed.join(", ")} must name their transactions in network_transactions`
            : `${String(named)} transactions omit ${omission.kind}, but only ${String(omission.count)} ${omission.kind} events were dropped`,
      });
  }
};

/** What in the capture itself shows that event coverage is incomplete. */
const eventGapCause = ({
  browser,
  scenario,
  events,
}: CapturedFields): string | undefined => {
  if (browser.mode === "connect") return "Connect mode";
  if (events.dropped > 0) return "Dropping events";
  const selected = enabledScenarioEventFamilies(
    scenario.event_families,
    scenario.network_content,
  );
  const popupGap = BROWSER_SCENARIO_POPUP_GAP_FAMILIES.some((family) =>
    selected.includes(family),
  );
  for (const event of events.items) {
    if (event.kind === "request-unfinished")
      return `Unfinished request ${event.transaction_id}`;
    if (
      event.kind === "network-content" &&
      browserNetworkContentUnavailable(event.headers, event.body)
    )
      return `Unavailable network content for ${event.transaction_id}`;
    if (event.kind === "popup-opened" && popupGap)
      return "A popup opened while frame, worker, WebSocket or download events were selected";
  }
  return undefined;
};

/**
 * Capture completeness aggregates the step ledgers that the steps' own facts
 * determine; only event coverage adds to it, and events are missing whenever
 * the capture shows an event gap.
 */
const refineCaptureCompleteness = (
  capture: CapturedFields,
  context: z.RefinementCtx,
): void => {
  const missing: readonly BrowserScenarioCompletenessSection[] =
    capture.completeness.missing_sections;
  const eventsMissing = missing.includes("events");
  const ledgers = capture.steps.map(deriveStepCompleteness);
  const expected = classifyBrowserScenarioCompleteness(
    [
      ...ledgers.flatMap(({ missing_sections: sections }) => sections),
      ...(eventsMissing ? (["events"] as const) : []),
    ],
    ledgers.flatMap(({ truncated_sections: sections }) => sections),
  );
  if (
    !sameCompletenessSections(missing, expected.missing_sections) ||
    !sameCompletenessSections(
      capture.completeness.truncated_sections,
      expected.truncated_sections,
    )
  )
    context.addIssue({
      code: "custom",
      path: ["completeness"],
      message:
        "Capture completeness must aggregate the step completeness ledgers, each section once; only events may add a missing section",
    });
  const gap = eventsMissing ? undefined : eventGapCause(capture);
  if (gap !== undefined)
    context.addIssue({
      code: "custom",
      path: ["completeness", "missing_sections"],
      message: `${gap} leaves event coverage incomplete, so events must be missing`,
    });
};

const sameUrl = (
  left: CapturedFields["steps"][number]["before_url"],
  right: CapturedFields["steps"][number]["after_url"],
): boolean => JSON.stringify(left) === JSON.stringify(right);

/**
 * A cancelled step captured nothing, and every step after the first action
 * that did not complete is a cancellation that never ran: no elapsed time,
 * navigation or received events. Step 0's outcome is the start-step rule's.
 */
const refineStepOutcomes = (
  { steps }: CapturedFields,
  context: z.RefinementCtx,
): void => {
  let unfinished = false;
  for (const [index, step] of steps.entries()) {
    if (
      step.status === "cancelled" &&
      Object.values(step.artifacts).some(
        ({ state }) => state === "captured" || state === "truncated",
      )
    )
      context.addIssue({
        code: "custom",
        path: ["steps", index, "artifacts"],
        message: "A cancelled step has no captured artifact",
      });
    if (
      unfinished &&
      (step.status !== "cancelled" ||
        step.elapsed_ms !== 0 ||
        step.event_sequence_end !== step.event_sequence_start - 1 ||
        !sameUrl(step.before_url, step.after_url))
    )
      context.addIssue({
        code: "custom",
        path: ["steps", index],
        message:
          "Steps after an action that did not complete are cancellations that never ran: no elapsed time, navigation or received events",
      });
    if (index > 0 && step.status !== "completed") unfinished = true;
  }
};

/** Step-indexed browser scenario observation. */
export const browserScenarioCaptureSchema = capturedFieldsSchema.superRefine(
  (capture, context) => {
    refineBrowserIdentity(capture, context);
    refineSelectedEventFamilies(capture, context);
    refineTransactionRange(capture, context);
    refineTransactionOmissions(capture, context);
    refineStartStep(capture, context);
    refineStepOutcomes(capture, context);
    refineCaptureCompleteness(capture, context);
    const bySequence = new Map(
      capture.events.items.map((event) => [event.sequence, event]),
    );
    if (bySequence.size !== capture.events.items.length)
      context.addIssue({
        code: "custom",
        path: ["events", "items"],
        message: "Event sequence numbers must be unique",
      });
    for (const [index, event] of capture.events.items.entries()) {
      if (event.kind !== "network-content") continue;
      const source = bySequence.get(event.source_event_sequence);
      if (
        source?.kind !== event.phase ||
        source.transaction_id !== event.transaction_id ||
        source.sequence >= event.sequence
      )
        context.addIssue({
          code: "custom",
          path: ["events", "items", index, "source_event_sequence"],
          message:
            "Network content must reference an earlier matching transaction phase",
        });
    }
    if (capture.events.retained !== capture.events.items.length)
      context.addIssue({
        code: "custom",
        path: ["events", "retained"],
        message: "Retained event count must equal items length",
      });
    if (
      capture.events.omissions.by_kind.reduce(
        (count, omission) => count + omission.count,
        0,
      ) !== capture.events.dropped
    )
      context.addIssue({
        code: "custom",
        path: ["events", "omissions", "by_kind"],
        message: "Per-kind omission counts must equal the dropped event count",
      });
    if (capture.steps.length !== capture.scenario.action_count + 1)
      context.addIssue({
        code: "custom",
        path: ["steps"],
        message: "Capture must include initial state and one entry per action",
      });
    const expectedIndices = capture.steps.map((_, index) => index);
    if (
      capture.steps.some(
        ({ step_index: index }, offset) => index !== expectedIndices[offset],
      )
    )
      context.addIssue({
        code: "custom",
        path: ["steps"],
        message: "Step indices must be contiguous from zero",
      });
    if (
      capture.events.items.some(
        ({ step_index: index }) => index >= capture.steps.length,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["events", "items"],
        message: "Event references an unknown step index",
      });
  },
);
export type BrowserScenarioCapture = z.infer<
  typeof browserScenarioCaptureSchema
>;

/** Capture fields shared by complete results and retained partial observations. */
export type BrowserScenarioCaptureData = Omit<
  BrowserScenarioCapture,
  "browser" | "steps" | "completeness" | "events"
> & {
  readonly browser: Omit<BrowserScenarioCapture["browser"], "cleanup"> & {
    readonly cleanup:
      | BrowserScenarioCapture["browser"]["cleanup"]
      | "incomplete";
  };
  readonly steps: readonly BrowserScenarioCapture["steps"][number][];
  readonly events: Omit<BrowserScenarioCapture["events"], "items"> & {
    readonly items: readonly BrowserScenarioCapture["events"]["items"][number][];
  };
};

/** Browser scenario data retained when an operation fails before a complete result. */
export interface BrowserScenarioPartialObservation {
  readonly kind: "browser-scenario-observation";
  readonly capture: BrowserScenarioCaptureData;
}
