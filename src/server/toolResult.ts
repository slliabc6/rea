import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { ToolResultDelivery as Delivery } from "./ToolResultDelivery.js";
import { INSPECT_ANALYSIS_VIEW_OPERATION } from "../domain/analysisView/analysisViewErrors.js";
import { inspectAnalysisViewInputSchema } from "../domain/analysisView/analysisView.js";
import type { Evidence } from "../domain/evidence.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";

/** Full delivery policy, including canonical native Evidence continuation. */
export class ToolResultDelivery extends Delivery {
  constructor(maximumResponseBytes: number) {
    super(maximumResponseBytes, nativeEvidenceContinuation);
  }
}

/** Create one delivery policy from the already selected, parsed response budget. */
export const createToolResultDelivery = (
  maximumResponseBytes: number | undefined,
): ToolResultDelivery =>
  new ToolResultDelivery(maximumResponseBytes ?? STDIO_DEFAULT_MAX_BUFFER_SIZE);

/** Offer a named, schema-validated source page only for retained native analysis. */
const nativeEvidenceContinuation = (
  evidence: Evidence,
): Readonly<Record<string, JsonValue>> => {
  if (evidence.operation !== "analyze_function") return {};
  const input = inspectAnalysisViewInputSchema.safeParse({
    source: { kind: "retained-evidence", evidence_id: evidence.evidence_id },
    view: { kind: "native", facet: "pseudocode", offset: 0 },
  });
  if (!input.success) return {};
  return {
    continuation: {
      name: INSPECT_ANALYSIS_VIEW_OPERATION,
      arguments: jsonValueSchema.parse(input.data),
    },
  };
};
