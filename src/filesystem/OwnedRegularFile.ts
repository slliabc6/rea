import type { FileHandle } from "node:fs/promises";

import { err, ok, type Result } from "../domain/result.js";
import { OwnedFileHandle } from "./OwnedFileHandle.js";
import { openRegularFile, RegularFileAdmissionFailure } from "./RegularFile.js";

export type RegularFileOperationOutcome<Value> =
  | { readonly kind: "completed"; readonly value: Value }
  | { readonly kind: "failed"; readonly cause: unknown };

/** A failed close transfers its exact descriptor owner and operation outcome. */
export class RegularFileCleanupFailure<Value = unknown> extends Error {
  constructor(
    readonly path: string,
    readonly owner: OwnedFileHandle,
    readonly outcome: RegularFileOperationOutcome<Value>,
    readonly cleanupCause: unknown,
    readonly retention:
      | { readonly kind: "not_requested" }
      | { readonly kind: "callback_returned" }
      | { readonly kind: "callback_threw"; readonly cause: unknown } = {
      kind: "not_requested",
    },
  ) {
    super(`Regular file cleanup failed for ${path}`, {
      cause: new AggregateError(
        [
          ...(outcome.kind === "failed" ? [outcome.cause] : []),
          cleanupCause,
          ...(retention.kind === "callback_threw" ? [retention.cause] : []),
        ],
        "File operation and cleanup failures",
      ),
    });
    this.name = "RegularFileCleanupFailure";
  }
}

export interface OwnedRegularFileOptions {
  readonly signal?: AbortSignal;
  readonly symlinks?: "follow" | "reject";
  readonly retainFailedClose?: (owner: OwnedFileHandle) => void;
}

/** Run an operation while one admitted descriptor and its cleanup owner stay together. */
export const withOwnedRegularFile = async <Value>(
  path: string,
  options: OwnedRegularFileOptions,
  operation: (handle: FileHandle) => Promise<Value>,
): Promise<Value> => {
  const handle = await openRegularFile(path, {
    symlinks: options.symlinks ?? "follow",
    signal: options.signal,
  }).catch((cause: unknown) => {
    if (!(cause instanceof RegularFileAdmissionFailure)) throw cause;
    const retention = retainOwner(options.retainFailedClose, cause.owner);
    throw new RegularFileCleanupFailure(
      path,
      cause.owner,
      { kind: "failed", cause: cause.cause },
      cause.cleanupCause,
      retention,
    );
  });
  const owner = new OwnedFileHandle(handle);
  let outcome: RegularFileOperationOutcome<Value>;
  try {
    outcome = { kind: "completed", value: await operation(handle) };
  } catch (cause: unknown) {
    outcome = { kind: "failed", cause };
  }
  let cleanup: Result<void, unknown>;
  try {
    await owner.close();
    cleanup = ok(undefined);
  } catch (cleanupCause: unknown) {
    cleanup = err(cleanupCause);
  }
  // Cleanup is part of the operation. Preserve an existing read failure, but
  // observe cancellation before either publishing success or retaining a close.
  if (outcome.kind === "completed" && options.signal?.aborted === true)
    outcome = { kind: "failed", cause: options.signal.reason };
  if (!cleanup.ok) {
    throw new RegularFileCleanupFailure(
      path,
      owner,
      outcome,
      cleanup.error,
      retainOwner(options.retainFailedClose, owner),
    );
  }
  if (outcome.kind === "failed") throw outcome.cause;
  return outcome.value;
};

const retainOwner = (
  retain: OwnedRegularFileOptions["retainFailedClose"],
  owner: OwnedFileHandle,
): RegularFileCleanupFailure["retention"] => {
  if (retain === undefined) return { kind: "not_requested" };
  try {
    retain(owner);
    return { kind: "callback_returned" };
  } catch (cause: unknown) {
    return { kind: "callback_threw", cause };
  }
};
