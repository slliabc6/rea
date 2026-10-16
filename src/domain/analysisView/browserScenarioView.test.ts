import { expect, it } from "vitest";

import {
  analysisViewRequestSchema,
  projectAnalysisView,
  type AnalysisViewParent,
  type AnalysisViewResult,
} from "./analysisView.js";
import {
  browserScenarioCaptureSchema,
  type BrowserScenarioCapture,
} from "../browserScenarioCapture.js";
import {
  SCENARIO_FIXTURE_OPEN_TREE,
  scenarioFixtureCompleteness,
  browserScenarioFixtureCapture,
  browserScenarioFixtureParameters,
  browserScenarioFixtureScenario,
} from "../browserScenarioCapture.fixture.js";
import {
  browserScenarioEventKindFamily,
  classifyBrowserScenarioCompleteness,
} from "../browserScenarioCaptureValues.js";
import { UNAVAILABLE_SUBJECT_LIMITATION } from "../evidence.js";
import { AnalysisInputError } from "../analysisErrorCore.js";

const PARENT_ID = `ev_${"c".repeat(64)}`;

const parent = (
  capture: BrowserScenarioCapture = browserScenarioFixtureCapture(),
  parameters: unknown = browserScenarioFixtureParameters(
    browserScenarioFixtureScenario(),
  ),
): AnalysisViewParent => ({
  evidenceId: PARENT_ID,
  operation: "capture_browser_scenario",
  normalizedResult: capture,
  subject: null,
  parameters,
  limitations: [
    UNAVAILABLE_SUBJECT_LIMITATION,
    ...capture.limitations,
    "Browser host platform and architecture were not observed.",
  ],
  artifact: null,
});

const project = (
  view: unknown,
  source: AnalysisViewParent = parent(),
): AnalysisViewResult => {
  const result = projectAnalysisView(
    source,
    analysisViewRequestSchema.parse(view),
  );
  if (!result.ok) throw result.error;
  return result.value;
};

const failure = (view: unknown, source: AnalysisViewParent = parent()) => {
  const result = projectAnalysisView(
    source,
    analysisViewRequestSchema.parse(view),
  );
  if (result.ok) throw new Error("expected the view to be rejected");
  return result.error;
};

const stepPage = (result: AnalysisViewResult) => {
  if (result.kind !== "browser-scenario" || result.page.collection !== "steps")
    throw new Error(`unexpected ${result.kind} view`);
  return result.page.items;
};

const artifactOf = (
  row: ReturnType<typeof stepPage>[number],
  artifact: string,
) => row.artifacts.find((entry) => entry.artifact === artifact);

it("compares each step with the previous capture and keeps recorded declarations", () => {
  const result = project({ kind: "browser-scenario", collection: "steps" });
  const rows = stepPage(result);

  expect(result).toMatchObject({
    parent_evidence_id: PARENT_ID,
    parent_operation: "capture_browser_scenario",
    artifact: { path: "", sha256: null },
    source_completeness: "incomplete",
    enabled_event_families: ["console", "network"],
    // The save response arrives after the final capture and belongs to no row.
    received_outside_step_windows: {
      retained: 2,
      kinds: [
        { kind: "request-finished", count: 1 },
        { kind: "response", count: 1 },
      ],
    },
    coverage: { status: "page", examined: 5, total: 5, exhausted: true },
  });
  expect(rows.map(({ action_class }) => action_class)).toEqual([
    "start-navigation",
    "input",
    "input",
    "input",
    "wait",
  ]);
  expect(rows[0]).toMatchObject({
    action: null,
    network_transactions: { coverage: "captured", retained: 1 },
  });
  expect(artifactOf(rows[0]!, "accessibility")).toMatchObject({
    coverage: "captured",
    change: null,
  });
  // Unrequested before and after: omitted rather than repeated.
  expect(artifactOf(rows[0]!, "screenshot")).toBeUndefined();

  expect(rows[1]?.action).toEqual(browserScenarioFixtureScenario().actions[0]);
  expect(artifactOf(rows[1]!, "accessibility")?.change).toBe("changed");
  expect(artifactOf(rows[1]!, "url")?.change).toBe("unchanged");

  // Closing the dialog restores the recorded accessibility text of step 0.
  expect(artifactOf(rows[2]!, "accessibility")).toMatchObject({
    change: "changed",
    comparison_sha256: artifactOf(rows[0]!, "accessibility")?.comparison_sha256,
  });

  expect(rows[3]).toMatchObject({
    status: "failed",
    error: "locator.click: Timeout 500ms exceeded.",
    network_transactions: { coverage: "captured", retained: 1 },
    events_received: {
      coverage: "captured",
      sequence_start: 5,
      sequence_end: 6,
      retained: 2,
      kinds: [
        { kind: "console", count: 1 },
        { kind: "request", count: 1 },
      ],
    },
  });
  expect(artifactOf(rows[3]!, "accessibility")?.change).toBe("unchanged");

  expect(rows[4]).toMatchObject({
    status: "cancelled",
    events_received: { retained: 0, kinds: [] },
  });
  for (const artifact of ["accessibility", "url", "screenshot"])
    expect(artifactOf(rows[4]!, artifact)).toMatchObject({
      coverage: "missing",
      reason: "action was not executed after an earlier failure",
      comparison_sha256: null,
      change: "unknown",
    });
});

it("summarizes coverage, step changes and events received outside step windows", () => {
  const result = project({ kind: "summary" });
  if (result.kind !== "summary" || !("step_changes" in result.summary))
    throw new Error("expected a browser scenario summary");
  const { summary } = result;

  expect(summary.step_statuses).toEqual({
    completed: 3,
    failed: 1,
    cancelled: 1,
  });
  expect(
    summary.artifact_coverage.find(({ artifact }) => artifact === "screenshot"),
  ).toEqual({
    artifact: "screenshot",
    captured: 0,
    not_requested: 4,
    missing: 1,
    truncated: 0,
  });
  expect(
    summary.step_changes.find(({ artifact }) => artifact === "accessibility"),
  ).toEqual({
    artifact: "accessibility",
    changed: 2,
    unchanged: 1,
    unknown: 1,
    not_compared: 0,
  });
  expect(summary.events).toEqual({
    declared_families: ["console", "network"],
    enabled_families: ["console", "network"],
    retained: 8,
    dropped: 0,
    received_outside_step_windows: {
      retained: 2,
      kinds: [
        { kind: "request-finished", count: 1 },
        { kind: "response", count: 1 },
      ],
    },
  });
  expect(summary.network_transactions).toEqual({
    coverage: "captured",
    retained: 2,
    omitted_by_transaction_limit: 0,
  });
  expect(result.limitations).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Cancelled steps have no post-action capture"),
    ]),
  );
  expect(result.unknowns).toEqual(
    expect.arrayContaining([
      expect.stringContaining(
        "screenshot was requested at some steps but not others",
      ),
    ]),
  );
});

it("pages retained text by UTF-16 code units and reports uncaptured text", () => {
  const first = project({
    kind: "browser-scenario",
    collection: "text",
    step_index: 1,
    artifact: "accessibility",
    limit: 10,
  });
  expect(first).toMatchObject({
    page: {
      collection: "text",
      step_id: "open-settings",
      item: {
        coverage: "captured",
        text: SCENARIO_FIXTURE_OPEN_TREE.slice(0, 10),
        unit: "utf16-code-units",
        total_code_units: SCENARIO_FIXTURE_OPEN_TREE.length,
      },
    },
    coverage: { next_offset: 10, exhausted: false },
  });

  expect(
    project({
      kind: "browser-scenario",
      collection: "text",
      step_index: 4,
      artifact: "accessibility",
      limit: 10,
    }),
  ).toMatchObject({
    page: {
      item: {
        coverage: "missing",
        reason: "action was not executed after an earlier failure",
      },
    },
    coverage: { status: "empty", exhausted: true },
  });
  expect(
    project({
      kind: "browser-scenario",
      collection: "text",
      step_index: 0,
      artifact: "dom",
      limit: 10,
    }),
  ).toMatchObject({
    page: { item: { coverage: "not_requested", reason: null } },
  });
  expect(
    failure({
      kind: "browser-scenario",
      collection: "text",
      step_index: 9,
      artifact: "dom",
      limit: 10,
    }),
  ).toBeInstanceOf(AnalysisInputError);
});

const selectingFamilies = (
  eventFamilies: BrowserScenarioCapture["scenario"]["event_families"],
  responseBody: boolean,
  items: BrowserScenarioCapture["events"]["items"],
) => {
  const fixture = browserScenarioFixtureCapture();
  return {
    ...fixture,
    scenario: {
      ...fixture.scenario,
      event_families: eventFamilies,
      network_content: {
        ...fixture.scenario.network_content,
        response_body: responseBody,
      },
    },
    events: { ...fixture.events, retained: items.length, items },
  };
};

const networkEvents = () =>
  browserScenarioFixtureCapture().events.items.filter(
    ({ kind }) => browserScenarioEventKindFamily(kind) === "network",
  );

it("treats network content selection as enabled network observation", () => {
  const steps = { kind: "browser-scenario", collection: "steps" };
  const contentOnly = stepPage(
    project(
      steps,
      parent(
        browserScenarioCaptureSchema.parse(
          selectingFamilies([], true, networkEvents()),
        ),
      ),
    ),
  );
  expect(contentOnly[3]?.events_received.coverage).toBe("captured");
  expect(contentOnly[3]?.network_transactions.retained).not.toBeNull();

  const nothingSelected = stepPage(
    project(
      steps,
      parent(
        browserScenarioCaptureSchema.parse(selectingFamilies([], false, [])),
      ),
    ),
  );
  expect(nothingSelected[3]?.events_received.coverage).toBe("not_requested");
  expect(nothingSelected[3]?.network_transactions).toEqual({
    coverage: "not_requested",
    retained: null,
  });
});

it("rejects retained events from families the scenario did not select", () => {
  const unselected = selectingFamilies(["console"], false, networkEvents());
  expect(
    failure(
      { kind: "browser-scenario", collection: "steps" },
      { ...parent(), normalizedResult: unselected },
    ),
  ).toMatchObject({
    issues: expect.arrayContaining([
      expect.objectContaining({
        path: ["source", "normalized_result", "events", "items", 0, "kind"],
      }),
    ]),
  });
});

it("rejects a step 0 that is not the completed implicit start navigation", () => {
  const fixture = browserScenarioFixtureCapture();
  const start = fixture.steps[0];
  if (start === undefined) throw new Error("Expected the start step");
  for (const replacement of [
    { step_id: "open-settings", action: "click" },
    {
      status: "failed",
      error: "navigation failed",
      completeness: classifyBrowserScenarioCompleteness(
        [...start.completeness.missing_sections, "action"],
        start.completeness.truncated_sections,
      ),
    },
  ]) {
    const steps = fixture.steps.map((step) =>
      step.step_index === 0 ? { ...step, ...replacement } : step,
    );
    expect(
      failure(
        { kind: "browser-scenario", collection: "steps" },
        {
          ...parent(),
          normalizedResult: {
            ...fixture,
            steps,
            completeness: scenarioFixtureCompleteness(steps),
          },
        },
      ),
    ).toMatchObject({
      issues: [{ path: ["source", "normalized_result", "steps", 0] }],
    });
  }
});

it("rejects a start window that leaves earlier receipts outside every window", () => {
  const fixture = browserScenarioFixtureCapture();
  expect(
    fixture.events.items.filter(({ sequence }) => sequence <= 2),
  ).toMatchObject([{ step_index: 0 }, { step_index: 0 }]);
  expect(
    failure(
      { kind: "browser-scenario", collection: "steps" },
      {
        ...parent(),
        normalizedResult: {
          ...fixture,
          steps: fixture.steps.map((step) =>
            step.step_index === 0
              ? { ...step, event_sequence_start: 2, event_sequence_end: 2 }
              : step,
          ),
        },
      },
    ),
  ).toMatchObject({
    issues: [
      {
        path: [
          "source",
          "normalized_result",
          "steps",
          0,
          "event_sequence_start",
        ],
      },
    ],
  });
});

it("rejects step completeness that contradicts the retained artifacts", () => {
  const fixture = browserScenarioFixtureCapture();
  expect(fixture.steps[1]?.artifacts.accessibility.state).toBe("captured");
  expect(
    failure(
      {
        kind: "browser-scenario",
        collection: "text",
        step_index: 1,
        artifact: "accessibility",
        limit: 10,
      },
      {
        ...parent(),
        normalizedResult: {
          ...fixture,
          steps: fixture.steps.map((step) =>
            step.step_index === 1
              ? {
                  ...step,
                  completeness: classifyBrowserScenarioCompleteness(
                    [],
                    ["accessibility"],
                  ),
                }
              : step,
          ),
        },
      },
    ),
  ).toMatchObject({
    issues: [
      { path: ["source", "normalized_result", "steps", 1, "completeness"] },
    ],
  });
});

it("rejects capture accounting that contradicts its steps or omissions", () => {
  const fixture = browserScenarioFixtureCapture();
  const rejected = (normalizedResult: unknown) =>
    failure({ kind: "summary" }, { ...parent(), normalizedResult });
  // A transaction-limited range without any dropped transaction event.
  expect(
    rejected({
      ...fixture,
      events: {
        ...fixture.events,
        omissions: {
          ...fixture.events.omissions,
          network_transaction_range: {
            first_transaction_id: "request-9",
            last_transaction_id: "request-9",
            count: 1,
            reason: "max-network-transactions",
          },
        },
      },
    }),
  ).toMatchObject({
    issues: [
      {
        path: [
          "source",
          "normalized_result",
          "events",
          "omissions",
          "network_transaction_range",
        ],
      },
    ],
  });
  // A complete capture ledger beside a failed and a cancelled step.
  expect(
    rejected({
      ...fixture,
      completeness: {
        status: "complete",
        equality_eligible: true,
        missing_sections: [],
        truncated_sections: [],
      },
    }),
  ).toMatchObject({
    issues: [{ path: ["source", "normalized_result", "completeness"] }],
  });
});

it("fails closed when recorded actions do not describe the capture steps", () => {
  const scenario = browserScenarioFixtureScenario();
  const parameters = browserScenarioFixtureParameters(scenario);
  const swapped = {
    ...parameters,
    actions: [
      scenario.actions[1],
      scenario.actions[0],
      ...scenario.actions.slice(2),
    ],
  };
  expect(
    failure(
      { kind: "browser-scenario", collection: "steps" },
      parent(undefined, swapped),
    ),
  ).toMatchObject({
    issues: [{ path: ["source", "parameters", "actions", 0] }],
  });
  expect(
    failure({ kind: "summary" }, parent(undefined, { scenario_sha256: "" })),
  ).toBeInstanceOf(AnalysisInputError);
});

it("rejects overlapping recorded event windows", () => {
  const fixture = browserScenarioFixtureCapture();
  const overlapping = browserScenarioCaptureSchema.parse({
    ...fixture,
    steps: fixture.steps.map((step) =>
      step.step_index === 1 ? { ...step, event_sequence_start: 3 } : step,
    ),
  });
  expect(
    failure(
      { kind: "browser-scenario", collection: "steps" },
      parent(overlapping),
    ),
  ).toMatchObject({
    issues: [
      {
        path: [
          "source",
          "normalized_result",
          "steps",
          1,
          "event_sequence_start",
        ],
      },
    ],
  });
});

it("states connect-mode ownership and rejects views for other parents", () => {
  const fixture = browserScenarioFixtureCapture();
  const connected = browserScenarioCaptureSchema.parse({
    ...fixture,
    browser: {
      ...fixture.browser,
      mode: "connect",
      process_ownership: "external",
      cleanup: "disconnected-external",
    },
    completeness: scenarioFixtureCompleteness(fixture.steps, true),
  });
  expect(project({ kind: "summary" }, parent(connected)).limitations).toEqual(
    expect.arrayContaining([expect.stringContaining("Connect mode attached")]),
  );
  expect(
    failure({ kind: "page", collection: "modules", offset: 0, limit: 1 }),
  ).toBeInstanceOf(AnalysisInputError);
});

const reparsed = (
  edit: (capture: BrowserScenarioCapture) => unknown,
): BrowserScenarioCapture =>
  browserScenarioCaptureSchema.parse(
    edit(structuredClone(browserScenarioFixtureCapture())),
  );

it("reports unobserved network as unknown instead of zero transactions", () => {
  const consoleOnly = reparsed((capture) => ({
    ...capture,
    scenario: { ...capture.scenario, event_families: ["console"] },
    events: {
      ...capture.events,
      retained: 3,
      items: capture.events.items.filter(({ kind }) => kind === "console"),
    },
  }));
  const result = project(
    { kind: "browser-scenario", collection: "steps" },
    parent(consoleOnly),
  );
  const save = stepPage(result)[3];
  expect(save?.events_received).toMatchObject({
    coverage: "captured",
    kinds: [{ kind: "console", count: 1 }],
  });
  expect(save?.network_transactions).toEqual({
    coverage: "not_requested",
    retained: null,
  });
  expect(result.unknowns).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^Event families .*network.* were not observed/u),
    ]),
  );
});

it("applies capture-wide event coverage to every step", () => {
  const dropped = reparsed((capture) => ({
    ...capture,
    events: {
      ...capture.events,
      dropped: 1,
      omissions: {
        ...capture.events.omissions,
        by_kind: [{ kind: "console", count: 1, reasons: ["max-events"] }],
      },
    },
    completeness: scenarioFixtureCompleteness(capture.steps, true),
  }));
  const truncatedRows = stepPage(
    project({ kind: "browser-scenario", collection: "steps" }, parent(dropped)),
  );
  expect(
    truncatedRows.map(({ events_received: events }) => events.coverage),
  ).toEqual(["truncated", "truncated", "truncated", "truncated", "truncated"]);

  const connected = reparsed((capture) => ({
    ...capture,
    browser: {
      ...capture.browser,
      mode: "connect",
      process_ownership: "external",
      cleanup: "disconnected-external",
    },
    completeness: {
      ...capture.completeness,
      missing_sections: [...capture.completeness.missing_sections, "events"],
    },
  }));
  const connectedRows = stepPage(
    project(
      { kind: "browser-scenario", collection: "steps" },
      parent(connected),
    ),
  );
  expect(connectedRows[0]?.events_received).toMatchObject({
    coverage: "missing",
    retained: 3,
  });
  expect(connectedRows[0]?.network_transactions).toEqual({
    coverage: "missing",
    retained: 1,
  });
});

it("keeps truncated artifacts and events between windows explicit", () => {
  const capture = reparsed((fixture) => {
    const steps = fixture.steps.map((step) =>
      step.step_index === 1
        ? {
            ...step,
            artifacts: {
              ...step.artifacts,
              accessibility: {
                state: "truncated",
                observed: 900,
                retained: 0,
                reason: "accessibility text exceeded its budget",
              },
            },
            completeness: {
              status: "truncated",
              equality_eligible: false,
              missing_sections: [],
              truncated_sections: ["accessibility"],
            },
          }
        : step.step_index === 3
          ? { ...step, event_sequence_start: 6 }
          : step,
    );
    return {
      ...fixture,
      steps,
      completeness: scenarioFixtureCompleteness(steps),
    };
  });
  const source = parent(capture);
  const rows = stepPage(
    project({ kind: "browser-scenario", collection: "steps" }, source),
  );
  expect(artifactOf(rows[1]!, "accessibility")).toMatchObject({
    coverage: "truncated",
    reason: "accessibility text exceeded its budget",
    comparison_sha256: null,
    change: "unknown",
  });
  expect(artifactOf(rows[2]!, "accessibility")?.change).toBe("unknown");
  // The save request now precedes step 3's window and belongs to no row.
  expect(rows[3]?.events_received).toMatchObject({
    sequence_start: 6,
    retained: 1,
    kinds: [{ kind: "console", count: 1 }],
  });
  expect(
    project({ kind: "browser-scenario", collection: "steps" }, source),
  ).toMatchObject({ received_outside_step_windows: { retained: 3 } });
  expect(
    project(
      {
        kind: "browser-scenario",
        collection: "text",
        step_index: 1,
        artifact: "accessibility",
        limit: 16,
      },
      source,
    ),
  ).toMatchObject({
    page: {
      item: {
        coverage: "truncated",
        reason: "accessibility text exceeded its budget",
      },
    },
  });
});

it("returns empty exhausted pages past the end", () => {
  expect(
    project({
      kind: "browser-scenario",
      collection: "steps",
      offset: 9,
      limit: 2,
    }),
  ).toMatchObject({
    page: { collection: "steps", items: [] },
    coverage: { status: "empty", next_offset: null, exhausted: true },
  });
  expect(
    project({
      kind: "browser-scenario",
      collection: "text",
      step_index: 1,
      artifact: "accessibility",
      offset: 10_000,
      limit: 16,
    }),
  ).toMatchObject({
    page: { item: { coverage: "captured", text: "" } },
    coverage: { status: "empty", exhausted: true },
  });
});

it("rejects inverted windows and events indexed to another step", () => {
  const inverted = reparsed((capture) => ({
    ...capture,
    steps: capture.steps.map((step) =>
      step.step_index === 1
        ? { ...step, event_sequence_start: 40, event_sequence_end: 2 }
        : step,
    ),
  }));
  expect(
    failure(
      { kind: "browser-scenario", collection: "steps" },
      parent(inverted),
    ),
  ).toMatchObject({
    issues: [
      {
        path: ["source", "normalized_result", "steps", 1, "event_sequence_end"],
      },
    ],
  });
  // An empty window still has to start after the previous step's window ends.
  const backwardEmpty = reparsed((capture) => ({
    ...capture,
    steps: capture.steps.map((step) =>
      step.step_index === 1
        ? { ...step, event_sequence_start: 2, event_sequence_end: 1 }
        : step,
    ),
  }));
  expect(
    failure(
      { kind: "browser-scenario", collection: "steps" },
      parent(backwardEmpty),
    ),
  ).toMatchObject({
    issues: [
      {
        path: [
          "source",
          "normalized_result",
          "steps",
          1,
          "event_sequence_start",
        ],
      },
    ],
  });
  const misindexed = reparsed((capture) => ({
    ...capture,
    events: {
      ...capture.events,
      items: capture.events.items.map((event) =>
        event.sequence === 4 ? { ...event, step_index: 2 } : event,
      ),
    },
  }));
  expect(
    failure(
      { kind: "browser-scenario", collection: "steps" },
      parent(misindexed),
    ),
  ).toMatchObject({
    issues: [{ path: ["source", "normalized_result", "events", "items"] }],
  });
});

it("keeps the view's own limitations when parent limitations exceed the budget", () => {
  const source = parent();
  const crowded: AnalysisViewParent = {
    ...source,
    limitations: Array.from(
      { length: 12 },
      (_, index) =>
        `Network metadata was omitted for request-${String(index)}: ${"x".repeat(1_000)}`,
    ),
  };
  const { limitations } = project({ kind: "summary" }, crowded);
  for (const owned of [
    "Step changes compare each step's capture",
    "Comparison digests apply no normalization rules",
    "Artifacts are read one after another",
    "events_received counts receipt",
    "Cancelled steps have no post-action capture",
  ])
    expect(limitations).toEqual(
      expect.arrayContaining([expect.stringContaining(owned)]),
    );
  expect(limitations).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/additional limitations omitted from this view/u),
    ]),
  );
});
