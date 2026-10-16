import type { FileHandle } from "node:fs/promises";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { withRegularFile } from "../../../src/application/RegularFileRead.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import {
  RegularFileCleanupFailure,
  withOwnedRegularFile,
} from "../../../src/filesystem/OwnedRegularFile.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each(
  (["metadata", "close"] as const).flatMap((stage) =>
    [false, true].map((scoped) => ({ stage, scoped })),
  ),
)(
  "observes cancellation after $stage with scope=$scoped",
  async ({ stage, scoped }) => {
    const root = await createTestTempDirectory("rea-file-finalization-");
    const path = join(root, "input.txt");
    const bytes = Buffer.from("unchanged fixture bytes");
    await writeFile(path, bytes);
    const controller = new AbortController();
    const reason = new Error("cancel during file finalization");
    const resources = scoped ? new ArtifactResourceScope() : undefined;
    let admitted: FileHandle | undefined;
    try {
      await expect(
        withRegularFile(
          path,
          async (handle) => {
            admitted = handle;
            const value = await handle.readFile();
            if (stage === "metadata") {
              const stat = handle.stat.bind(handle);
              vi.spyOn(handle, "stat").mockImplementation(async () => {
                const metadata = await stat();
                controller.abort(reason);
                return metadata;
              });
            } else {
              const close = handle.close.bind(handle);
              vi.spyOn(handle, "close").mockImplementation(async () => {
                await close();
                controller.abort(reason);
              });
            }
            return value;
          },
          { signal: controller.signal, ...(resources ? { resources } : {}) },
        ),
      ).rejects.toBe(reason);
      expect(admitted?.fd).toBe(-1);
      expect(resources?.hasPending ?? false).toBe(false);
      await resources?.retryCleanup();
      expect(await readFile(path)).toEqual(bytes);
    } finally {
      vi.restoreAllMocks();
      await resources?.close();
    }
  },
);

it("observes cancellation during a recovered descriptor close", async () => {
  const root = await createTestTempDirectory("rea-file-retry-cancel-");
  const path = join(root, "input.txt");
  await writeFile(path, "fixture bytes");
  const controller = new AbortController();
  const reason = new Error("cancel during close retry");
  const resources = new ArtifactResourceScope();
  const nativeClose = OwnedFileHandle.prototype.close;
  let attempts = 0;
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(async function (this: OwnedFileHandle) {
      if (++attempts === 1) throw new Error("transient close failure");
      await nativeClose.call(this);
      controller.abort(reason);
    });
  try {
    await expect(
      withRegularFile(path, (handle) => handle.readFile(), {
        signal: controller.signal,
        resources,
      }),
    ).rejects.toBe(reason);
    expect(attempts).toBe(2);
    expect(resources.hasPending).toBe(false);
    await resources.retryCleanup();
  } finally {
    close.mockRestore();
    await resources.close();
  }
});

it.each(["completed", "failed"] as const)(
  "retains the primary outcome when close fails after cancellation: %s",
  async (outcome) => {
    const root = await createTestTempDirectory("rea-file-close-cancel-");
    const path = join(root, "input.txt");
    await writeFile(path, "fixture bytes");
    const controller = new AbortController();
    const reason = new Error("cancel during failed close");
    const primary = new Error("existing read failure");
    const cleanupCause = new Error("injected close failure");
    const retained: OwnedFileHandle[] = [];
    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementationOnce(async () => {
        controller.abort(reason);
        throw cleanupCause;
      });
    try {
      let failure: unknown;
      try {
        await withOwnedRegularFile(
          path,
          {
            signal: controller.signal,
            retainFailedClose: (owner) => retained.push(owner),
          },
          async (handle) => {
            const bytes = await handle.readFile();
            if (outcome === "failed") throw primary;
            return bytes;
          },
        );
      } catch (cause: unknown) {
        failure = cause;
      }
      expect(failure).toBeInstanceOf(RegularFileCleanupFailure);
      if (!(failure instanceof RegularFileCleanupFailure))
        throw new Error("Expected the retained close owner");
      expect(failure.outcome).toEqual({
        kind: "failed",
        cause: outcome === "failed" ? primary : reason,
      });
      expect(failure.cleanupCause).toBe(cleanupCause);
      expect(retained).toEqual([failure.owner]);
      expect(failure.owner.handle.fd).toBeGreaterThanOrEqual(0);
    } finally {
      close.mockRestore();
      await retained[0]?.close();
    }
    expect(retained[0]?.handle.fd).toBe(-1);
  },
);
