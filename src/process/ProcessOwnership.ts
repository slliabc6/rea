import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  errorMessage,
  readLiveProcessTable,
  systemProcessOwnershipHost as systemHost,
} from "./ProcessOwnershipObservation.js";
import { launcherIdentityFailure } from "./ProcessOwnershipIdentity.js";
import { descendantsOf, liveProcesses } from "./ProcessOwnershipProcessTree.js";
import {
  classifyProcessRunToken,
  readProcessRunTokens,
} from "./ProcessRunTokenObservations.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";

const execFileAsync = promisify(execFile);

/** Identity proof required before REA may signal an owned process group. */
export interface OwnedProcessGroup {
  readonly runId: string;
  readonly leaderPid: number;
  readonly processGroupId: number;
  /** Expected launcher identity, checked only while the leader exists. */
  readonly expectedCommand?: string;
  /** Expected launcher parent, checked only while the leader exists. */
  readonly expectedParentPid?: number;
  /** Scan all live processes for this run token during cleanup. */
  readonly sweepTokenOwnedProcesses?: boolean;
  /** Prelaunch process identities for this capture; absent on generic callers. */
  readonly captureBaseline?: ProcessOwnershipBaseline;
  /**
   * Groups observed in capture samples. Observation adds cleanup candidates but
   * does not authorize signaling; every live member still needs token proof.
   */
  readonly sampledProcessGroupIds?: readonly number[];
}

/** Capture-local baseline; null means the PID identity could not be established. */
export type ProcessOwnershipBaseline = readonly {
  readonly pid: number;
  readonly identity: string | null;
}[];

/** One entry from an operating-system process-table snapshot. */
export interface ProcessTableEntry {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  /** Effective owner when the process table reports it. */
  readonly uid?: number;
  readonly state: string;
  readonly command: string;
}

/** Native process start identity; unavailable identities must never be skipped. */
export type ProcessIdentityObservation =
  | { readonly state: "readable"; readonly identity: string }
  | { readonly state: "unavailable"; readonly reason: string };

/** Token-verified process lineage retained for one owned provider run. */
export interface OwnedProcessLineage {
  readonly runId: string;
  readonly launcherPid: number;
  readonly launcherParentPid: number;
  readonly processGroupId: number;
  readonly descendants: readonly {
    readonly pid: number;
    readonly parentPid: number;
    readonly processGroupId: number;
  }[];
}

/** Result of observing owned lineage without signaling any process. */
export type ProcessLineageObservation =
  | {
      readonly status: "verified";
      readonly observedAt: string;
      readonly lineage: OwnedProcessLineage;
    }
  | {
      readonly status: "unavailable";
      readonly observedAt: string;
      readonly runId: string;
      readonly launcherPid: number;
      readonly processGroupId: number;
      readonly reason: string;
    };

/** Narrow operating-system seam used to inspect processes and signal groups. */
export interface ProcessOwnershipHost {
  readonly platform?: NodeJS.Platform;
  /** Prepare required native identity inspection before launching a child. */
  prepare?(signal?: AbortSignal): Promise<void>;
  /** Release owned native inspection helpers and their temporary files. */
  close?(): Promise<void>;
  /** List current processes; startup inspection may be cancelled by the caller. */
  listProcesses(signal?: AbortSignal): Promise<readonly ProcessTableEntry[]>;
  environment(
    pid: number,
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, string>>>;
  /** Read only run-token values in one host operation when the OS supports it. */
  runTokens?(
    processes: readonly ProcessTableEntry[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<number, ProcessRunTokenObservation>>;
  /** Read stable identities; omit the signal during cleanup so it can finish. */
  processIdentities?(
    processes: readonly ProcessTableEntry[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<number, ProcessIdentityObservation>>;
  /** Snapshot identities before launch, honoring startup cancellation. */
  captureBaseline?(signal?: AbortSignal): Promise<ProcessOwnershipBaseline>;
  signalGroup(processGroupId: number, signal: NodeJS.Signals): void;
}

/** Whether one live process exposed its ownership token to the host. */
export type ProcessRunTokenObservation =
  | { readonly state: "readable"; readonly runId: string | undefined }
  | { readonly state: "unavailable"; readonly reason: string };

/** Narrow Windows P0 seam for bounded process-tree termination. */
export interface WindowsProcessTreeHost {
  terminateTree(rootPid: number): Promise<"terminated" | "missing">;
}

/** Per-member reason that token-verified cleanup failed closed. */
interface ProcessOwnershipValidationFailure {
  readonly pid: number;
  readonly reason:
    | "environment-unreadable"
    | "run-token-mismatch"
    | "process-identity-unavailable";
  readonly diagnostic?: string;
}

/**
 * One live process the ownership sweep could not attribute or exonerate.
 * Recorded as evidence instead of failing the capture: the process is not
 * related to the owned tree, so cleanup cannot act on it and the operating
 * system withheld or removed its token (for example, macOS strips the
 * environment of Apple platform binaries, and foreign-uid processes return
 * EINVAL for KERN_PROCARGS2).
 */
export interface OwnershipSweepUnverifiedProcess {
  readonly pid: number;
  readonly diagnostic: string;
}

/** Capture-owned process structures used to classify sweep candidates. */
export interface OwnershipSweepRelation {
  readonly leaderPid: number;
  readonly processGroupId: number;
  readonly sampledProcessGroupIds?: readonly number[];
}

/** Cleanup outcome with per-member diagnostics when ownership is uncertain. */
export type ProcessCleanupResult =
  | {
      readonly cleaned: true;
      readonly signaled: boolean;
      readonly unverified?: readonly OwnershipSweepUnverifiedProcess[];
    }
  | ProcessCleanupFailure;

/** Retained verification failures for one cleanup attempt, without additional signaling authority. */
export interface ProcessCleanupFailure {
  readonly cleaned: false;
  readonly reason: string;
  readonly failures?: readonly ProcessOwnershipValidationFailure[];
  readonly unverified?: readonly OwnershipSweepUnverifiedProcess[];
}

/** Token-verified liveness result used by post-root-exit settlement. */
export type ProcessGroupObservation =
  | { readonly state: "empty" }
  | { readonly state: "alive" }
  | { readonly state: "unverifiable"; readonly reason: string };

/**
 * Terminate one Windows process tree through the platform utility.
 *
 * This is a bounded P0 cleanup mechanism, not Job Object ownership proof. The
 * caller-visible Windows capability report remains unavailable until a native
 * authority verifies Job Object creation, membership, and cleanup semantics.
 */
export const cleanupWindowsProcessTree = async (
  rootPid: number,
  host: WindowsProcessTreeHost = systemWindowsProcessTreeHost,
): Promise<ProcessCleanupResult> => {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0)
    return { cleaned: false, reason: "Windows process-tree PID is invalid" };
  try {
    const result = await host.terminateTree(rootPid);
    return { cleaned: true, signaled: result === "terminated" };
  } catch (cause: unknown) {
    return {
      cleaned: false,
      reason: `Windows process-tree termination failed for PID ${String(rootPid)}: ${errorMessage(cause)}`,
    };
  }
};

const systemWindowsProcessTreeHost: WindowsProcessTreeHost = {
  async terminateTree(rootPid) {
    try {
      await execFileAsync(
        "taskkill.exe",
        ["/pid", String(rootPid), "/t", "/f"],
        { windowsHide: true, timeout: 5_000 },
      );
      return "terminated";
    } catch (cause: unknown) {
      if (
        cause instanceof Error &&
        "code" in cause &&
        (cause.code === 128 || cause.code === "ESRCH")
      )
        return "missing";
      throw cause;
    }
  },
};

/** Read the capture run token currently exposed by one live process. */
export const readProcessRunId = async (
  pid: number,
  host: ProcessOwnershipHost = systemHost,
  signal?: AbortSignal,
): Promise<string | undefined> =>
  (await host.environment(pid, signal)).REA_PROCESS_RUN_ID;

/** Keep unrelated-process uncertainty attached to every outcome of this cleanup attempt. */
const mergeUnverifiedProcesses = (
  destination: OwnershipSweepUnverifiedProcess[],
  observations: readonly OwnershipSweepUnverifiedProcess[],
): void => {
  if (observations.length === 0) return;
  const seen = new Map<number, Set<string>>();
  for (const { pid, diagnostic } of destination) {
    const diagnostics = seen.get(pid) ?? new Set<string>();
    diagnostics.add(diagnostic);
    seen.set(pid, diagnostics);
  }
  for (const observation of observations) {
    const diagnostics = seen.get(observation.pid) ?? new Set<string>();
    if (!diagnostics.has(observation.diagnostic)) {
      destination.push(observation);
      diagnostics.add(observation.diagnostic);
      seen.set(observation.pid, diagnostics);
    }
  }
};

const withUnverifiedObservations = <Result extends ProcessCleanupResult>(
  result: Result,
  unverified: readonly OwnershipSweepUnverifiedProcess[],
): Result => {
  const observations = [...unverified];
  mergeUnverifiedProcesses(observations, result.unverified ?? []);
  return observations.length === 0
    ? result
    : { ...result, unverified: observations };
};

/** Token-validate every rooted POSIX process group before signaling any. */
export const cleanupOwnedProcessGroup = async (
  ownership: OwnedProcessGroup,
  host: ProcessOwnershipHost = systemHost,
): Promise<ProcessCleanupResult> => {
  const processTable = await readLiveProcessTable(host);
  if (!processTable.available)
    return {
      cleaned: false,
      reason: `process table could not be inspected: ${processTable.reason}`,
    };
  let processes = processTable.processes;
  let signaled = false;
  const unverified: OwnershipSweepUnverifiedProcess[] = [];
  const sweepBudget = { remainingRefreshes: TOKEN_READ_RETRY_ATTEMPTS - 1 };
  let pendingRefresh: OwnedCleanupRefresh | undefined;
  for (let attempt = 0; attempt < TOKEN_READ_RETRY_ATTEMPTS; attempt++) {
    const plan = await createOwnedCleanupPlan(
      ownership,
      processes,
      host,
      sweepBudget,
    );
    mergeUnverifiedProcesses(unverified, plan.unverified ?? []);
    if ("kind" in plan) {
      pendingRefresh = plan;
      processes = plan.processes;
      continue;
    }
    if ("cleaned" in plan)
      return withUnverifiedObservations(
        plan.cleaned ? { ...plan, signaled: signaled || plan.signaled } : plan,
        unverified,
      );
    const unresolved = [...plan.unresolved];
    pendingRefresh = undefined;
    for (const processGroupId of plan.signalOrder) {
      const revalidation = await revalidateOwnedProcessGroup(
        processGroupId,
        ownership,
        host,
        plan,
        sweepBudget,
      );
      mergeUnverifiedProcesses(unverified, revalidation.unverified ?? []);
      if ("kind" in revalidation) {
        pendingRefresh = revalidation;
        processes = revalidation.processes;
        break;
      }
      if ("cleaned" in revalidation) {
        return withUnverifiedObservations(revalidation, unverified);
      }
      for (const failure of revalidation.unresolved)
        mergeProcessOwnershipFailure(unresolved, failure);
      if (!revalidation.signalable) continue;
      try {
        host.signalGroup(processGroupId, "SIGKILL");
        signaled = true;
      } catch (cause: unknown) {
        const code =
          cause instanceof Error && "code" in cause ? cause.code : undefined;
        if (code !== "ESRCH")
          return withUnverifiedObservations(
            {
              cleaned: false,
              reason: `owned process group signal failed: ${errorMessage(cause)}`,
            },
            unverified,
          );
      }
    }
    if (pendingRefresh !== undefined) continue;
    if (unresolved.length > 0)
      return cleanupValidationFailure(unresolved, unverified);
    return {
      cleaned: true,
      signaled,
      ...(unverified.length === 0 ? {} : { unverified }),
    };
  }
  return cleanupValidationFailure(pendingRefresh?.failures ?? [], unverified);
};

/** Verify that no live process still carries an owned capture run token. */
export const verifyNoTokenOwnedProcesses = async (
  runId: string,
  host: ProcessOwnershipHost = systemHost,
  captureBaseline?: ProcessOwnershipBaseline,
  relation?: OwnershipSweepRelation,
): Promise<ProcessCleanupResult> => {
  const processTable = await readLiveProcessTable(host);
  if (!processTable.available)
    return {
      cleaned: false,
      reason: `process table could not be inspected: ${processTable.reason}`,
    };
  const scan = await scanTokenOwnedProcesses(
    processTable.processes,
    runId,
    host,
    captureBaseline,
    relation,
  );
  if ("cleaned" in scan) return scan;
  if (scan.failures.length > 0)
    return cleanupValidationFailure(scan.failures, scan.unverified);
  if (scan.owned.length > 0)
    return {
      cleaned: false,
      reason: "token-owned process remained after cleanup",
      ...(scan.unverified.length === 0 ? {} : { unverified: scan.unverified }),
    };
  return {
    cleaned: true,
    signaled: false,
    ...(scan.unverified.length === 0 ? {} : { unverified: scan.unverified }),
  };
};

interface OwnedCleanupPlan {
  readonly signalOrder: readonly number[];
  readonly processGroupIds: ReadonlySet<number>;
  readonly tokenOwnedIdentities: ReadonlyMap<number, string | null>;
  readonly unresolved: readonly ProcessOwnershipValidationFailure[];
  readonly unverified: readonly OwnershipSweepUnverifiedProcess[];
}

/** Fresh token proof discovers groups outside the current bounded plan. */
interface OwnedCleanupRefresh {
  readonly kind: "refresh";
  readonly processes: readonly ProcessTableEntry[];
  /** Current uncertainty and discovery diagnostics if the retry budget expires. */
  readonly failures: readonly ProcessOwnershipValidationFailure[];
  readonly unverified: readonly OwnershipSweepUnverifiedProcess[];
}

// A process-table read can race exit and retain the old state with an altered
// command. Only a fresh table proving that PID is no longer live can settle
// that mismatch; surviving group members still require normal token checks.
const settleLauncherExit = async (
  ownership: OwnedProcessGroup,
  processes: readonly ProcessTableEntry[],
  host: ProcessOwnershipHost,
): Promise<
  | readonly ProcessTableEntry[]
  | Extract<ProcessCleanupResult, { readonly cleaned: false }>
> => {
  const launcher = processes.find(({ pid }) => pid === ownership.leaderPid);
  if (launcher === undefined) return processes;
  const reason = launcherIdentityFailure(launcher, ownership);
  if (reason === null) return processes;
  const refreshed = await readLiveProcessTable(host);
  if (
    refreshed.available &&
    !refreshed.processes.some(({ pid }) => pid === launcher.pid)
  ) {
    // Refreshing must not discard a surviving detached descendant's lineage,
    // including a child that changed groups while the launcher exited.
    const descendants = descendantsOf([launcher.pid], processes);
    const descendantPids = new Set(descendants.map(({ pid }) => pid));
    const descendantGroupIds = new Set(
      descendants.map(({ processGroupId }) => processGroupId),
    );
    const refreshedDescendantPids = new Set(
      descendantsOf(
        descendants.map(({ pid }) => pid),
        refreshed.processes,
      ).map(({ pid }) => pid),
    );
    if (
      refreshed.processes.some(
        (process) =>
          process.processGroupId !== ownership.processGroupId &&
          (refreshedDescendantPids.has(process.pid) ||
            descendantPids.has(process.pid) ||
            descendantGroupIds.has(process.processGroupId)),
      )
    )
      return { cleaned: false, reason };
    return refreshed.processes;
  }
  return { cleaned: false, reason };
};

const createOwnedCleanupPlan = async (
  ownership: OwnedProcessGroup,
  initialProcesses: readonly ProcessTableEntry[],
  host: ProcessOwnershipHost,
  sweepBudget: OwnershipSweepBudget,
): Promise<OwnedCleanupPlan | ProcessCleanupResult | OwnedCleanupRefresh> => {
  const settledProcesses = await settleLauncherExit(
    ownership,
    initialProcesses,
    host,
  );
  if ("cleaned" in settledProcesses) return settledProcesses;
  const sampledProcessGroupIds = new Set(
    (ownership.sampledProcessGroupIds ?? []).filter(
      (processGroupId) =>
        Number.isSafeInteger(processGroupId) && processGroupId > 0,
    ),
  );
  const tokenOwned =
    ownership.sweepTokenOwnedProcesses === true
      ? await scanTokenOwnedProcesses(
          settledProcesses,
          ownership.runId,
          host,
          ownership.captureBaseline,
          {
            leaderPid: ownership.leaderPid,
            processGroupId: ownership.processGroupId,
            ...(sampledProcessGroupIds.size === 0
              ? {}
              : { sampledProcessGroupIds: [...sampledProcessGroupIds] }),
          },
          sweepBudget,
        )
      : {
          processes: settledProcesses,
          owned: [],
          failures: [],
          unverified: [],
          identities: new Map(),
        };
  if ("cleaned" in tokenOwned) return tokenOwned;
  const processes = tokenOwned.processes;
  const unverified = [...tokenOwned.unverified];
  const tokenOwnedGroupIds = new Set(
    tokenOwned.owned.map(({ processGroupId }) => processGroupId),
  );
  const launcher = processes.find(({ pid }) => pid === ownership.leaderPid);
  const rootMembers = processes.filter(
    ({ processGroupId }) => processGroupId === ownership.processGroupId,
  );
  if (
    launcher === undefined &&
    rootMembers.length === 0 &&
    tokenOwned.owned.length === 0 &&
    !processes.some(({ processGroupId }) =>
      sampledProcessGroupIds.has(processGroupId),
    )
  )
    return tokenOwned.failures.length > 0
      ? {
          signalOrder: [],
          processGroupIds: new Set(),
          tokenOwnedIdentities: tokenOwned.identities,
          unresolved: tokenOwned.failures,
          unverified,
        }
      : {
          cleaned: true,
          signaled: false,
          ...(unverified.length === 0 ? {} : { unverified }),
        };
  let descendants: readonly ProcessTableEntry[] = [];
  if (launcher !== undefined) {
    descendants = descendantsOf([launcher.pid], processes);
  }
  const descendantPids = new Set(descendants.map(({ pid }) => pid));
  const processGroupIds = new Set<number>([ownership.processGroupId]);
  for (const descendant of descendants)
    processGroupIds.add(descendant.processGroupId);
  for (const process of tokenOwned.owned)
    processGroupIds.add(process.processGroupId);
  for (const processGroupId of sampledProcessGroupIds)
    processGroupIds.add(processGroupId);
  const signalableGroups = new Set<number>();
  let unresolved = [...tokenOwned.failures];
  const unverifiableSampledGroups = new Set<number>();
  for (const processGroupId of processGroupIds) {
    if (processGroupId === ownership.processGroupId) continue;
    const groupLeader = processes.find(
      ({ pid, processGroupId: observedGroupId }) =>
        pid === processGroupId && observedGroupId === processGroupId,
    );
    if (
      (groupLeader === undefined || !descendantPids.has(groupLeader.pid)) &&
      !tokenOwnedGroupIds.has(processGroupId) &&
      !sampledProcessGroupIds.has(processGroupId)
    )
      return {
        cleaned: false,
        reason:
          "descendant process-group leader identity could not be verified",
      };
    if (
      (groupLeader === undefined || !descendantPids.has(groupLeader.pid)) &&
      !tokenOwnedGroupIds.has(processGroupId) &&
      ownership.sweepTokenOwnedProcesses !== true
    )
      unverifiableSampledGroups.add(processGroupId);
  }
  const liveMembers = processes.filter(({ processGroupId }) =>
    processGroupIds.has(processGroupId),
  );
  for (const processGroupId of processGroupIds) {
    const members = liveMembers.filter(
      ({ processGroupId: observedGroupId }) =>
        observedGroupId === processGroupId,
    );
    if (members.length === 0) continue;
    const validation = await validateProcessGroupMembers(
      processGroupId,
      members,
      ownership.runId,
      host,
      tokenOwned.identities,
    );
    const { failures, members: validatedMembers } = validation;
    const sweep = await reconcileRefreshedSweep(
      validation,
      ownership,
      processGroupIds,
      host,
      sweepBudget,
    );
    if (sweep !== undefined) {
      mergeUnverifiedProcesses(unverified, sweep.unverified ?? []);
      if ("cleaned" in sweep)
        return withUnverifiedObservations(sweep, unverified);
      if ("kind" in sweep) return { ...sweep, unverified };
      for (const failure of sweep.failures)
        mergeProcessOwnershipFailure(unresolved, failure);
    }
    const checkedPids = new Set(members.map(({ pid }) => pid));
    const refreshedLivePids =
      validation.refreshedProcesses === undefined
        ? undefined
        : new Set(validation.refreshedProcesses.map(({ pid }) => pid));
    // Later validation replaces a sweep diagnosis only with fresh ownership
    // proof or confirmed exit. Missing start identity cannot be repaired by
    // seeing the expected token on a potentially reused PID.
    unresolved = unresolved.filter((failure) => {
      if (
        !checkedPids.has(failure.pid) ||
        failures.some(({ pid }) => pid === failure.pid)
      )
        return true;
      if (
        refreshedLivePids !== undefined &&
        !refreshedLivePids.has(failure.pid)
      )
        return false;
      return (
        failure.reason === "process-identity-unavailable" &&
        !tokenOwned.identities.has(failure.pid)
      );
    });
    if (failures.length === 0 && unverifiableSampledGroups.has(processGroupId))
      unresolved.push(
        ...validatedMembers.map(({ pid }) => ({
          pid,
          reason: "process-identity-unavailable" as const,
          diagnostic:
            "sampled process-group leader identity could not be verified",
        })),
      );
    for (const failure of failures)
      mergeProcessOwnershipFailure(unresolved, failure);
    if (
      failures.length === 0 &&
      !unresolved.some(({ pid }) => checkedPids.has(pid)) &&
      validatedMembers.length > 0 &&
      !unverifiableSampledGroups.has(processGroupId)
    )
      signalableGroups.add(processGroupId);
  }
  if (ownership.sweepTokenOwnedProcesses !== true && unresolved.length > 0)
    return cleanupValidationFailure(unresolved, unverified);
  return {
    processGroupIds,
    signalOrder: [...signalableGroups]
      .filter((groupId) => processGroupIds.has(groupId))
      .sort((left, right) =>
        left === ownership.processGroupId
          ? -1
          : right === ownership.processGroupId
            ? 1
            : left - right,
      ),
    tokenOwnedIdentities: tokenOwned.identities,
    unresolved,
    unverified,
  };
};

/** Keep one current, most useful ownership diagnosis for each live PID. */
const mergeProcessOwnershipFailure = (
  failures: ProcessOwnershipValidationFailure[],
  next: ProcessOwnershipValidationFailure,
): void => {
  const index = failures.findIndex(({ pid }) => pid === next.pid);
  if (index < 0) {
    failures.push(next);
    return;
  }
  const previous = failures[index];
  if (
    previous !== undefined &&
    ownershipFailurePriority(next.reason) >=
      ownershipFailurePriority(previous.reason)
  )
    failures[index] = next;
};

const ownershipFailurePriority = (
  reason: ProcessOwnershipValidationFailure["reason"],
): number =>
  reason === "run-token-mismatch"
    ? 3
    : reason === "process-identity-unavailable"
      ? 2
      : reason === "environment-unreadable"
        ? 1
        : 0;

const revalidateOwnedProcessGroup = async (
  processGroupId: number,
  ownership: OwnedProcessGroup,
  host: ProcessOwnershipHost,
  plan: OwnedCleanupPlan,
  sweepBudget: OwnershipSweepBudget,
): Promise<
  | {
      readonly signalable: boolean;
      readonly unresolved: readonly ProcessOwnershipValidationFailure[];
      readonly unverified: readonly OwnershipSweepUnverifiedProcess[];
    }
  | ProcessCleanupResult
  | OwnedCleanupRefresh
> => {
  let members: readonly ProcessTableEntry[];
  let observedProcesses: readonly ProcessTableEntry[];
  const unresolved: ProcessOwnershipValidationFailure[] = [];
  const unverified: OwnershipSweepUnverifiedProcess[] = [];
  try {
    const table = await readLiveProcessTable(host);
    if (!table.available)
      return {
        cleaned: false,
        reason: `process ownership could not be revalidated: ${table.reason}`,
      };
    const processes = await settleLauncherExit(
      ownership,
      table.processes,
      host,
    );
    if ("cleaned" in processes) return processes;
    observedProcesses = processes;
    members = processes.filter(
      ({ processGroupId: observedGroupId }) =>
        observedGroupId === processGroupId,
    );
  } catch (cause: unknown) {
    return {
      cleaned: false,
      reason: `process ownership could not be revalidated: ${errorMessage(cause)}`,
    };
  }
  const validation = await validateProcessGroupMembers(
    processGroupId,
    members,
    ownership.runId,
    host,
    plan.tokenOwnedIdentities,
  );
  const sweep = await reconcileRefreshedSweep(
    {
      ...validation,
      refreshedProcesses: validation.refreshedProcesses ?? observedProcesses,
    },
    ownership,
    plan.processGroupIds,
    host,
    sweepBudget,
  );
  if (sweep !== undefined) {
    mergeUnverifiedProcesses(unverified, sweep.unverified ?? []);
    if ("cleaned" in sweep)
      return withUnverifiedObservations(sweep, unverified);
    if ("kind" in sweep) return sweep;
    for (const failure of sweep.failures)
      mergeProcessOwnershipFailure(unresolved, failure);
  }
  if (
    validation.failures.length > 0 &&
    ownership.sweepTokenOwnedProcesses !== true
  )
    return cleanupValidationFailure(validation.failures);
  for (const failure of validation.failures)
    mergeProcessOwnershipFailure(unresolved, failure);
  members = validation.members;
  if (
    processGroupId !== ownership.processGroupId &&
    members.length > 0 &&
    !members.some(({ pid }) => pid === processGroupId) &&
    ownership.sweepTokenOwnedProcesses !== true
  )
    return {
      cleaned: false,
      reason:
        "descendant process-group leader identity could not be revalidated",
    };
  // A swept group's uncertainty cannot authorize its signal, but must not
  // prevent cleanup of independently verified groups in the same plan.
  return {
    signalable: validation.failures.length === 0 && members.length > 0,
    unresolved,
    unverified,
  };
};

const cleanupValidationFailure = (
  failures: readonly ProcessOwnershipValidationFailure[],
  unverified: readonly OwnershipSweepUnverifiedProcess[] = [],
): ProcessCleanupFailure => {
  const unverifiedEntry = unverified.length === 0 ? {} : { unverified };
  const unreadable = failures.filter(
    ({ reason }) => reason === "environment-unreadable",
  );
  if (failures.some(({ reason }) => reason === "run-token-mismatch"))
    return {
      cleaned: false,
      reason: `process ownership token mismatch for PID(s): ${[
        ...new Set(
          failures
            .filter(({ reason }) => reason === "run-token-mismatch")
            .map(({ pid }) => pid),
        ),
      ]
        .sort((left, right) => left - right)
        .join(", ")}`,
      failures,
      ...unverifiedEntry,
    };
  if (failures.some(({ reason }) => reason === "process-identity-unavailable"))
    return {
      cleaned: false,
      reason: "process identity could not be revalidated",
      failures,
      ...unverifiedEntry,
    };
  if (unreadable.length > 0) {
    const counts = new Map<string, number>();
    for (const { diagnostic } of unreadable) {
      const category = sanitizedTokenReadFailure(diagnostic);
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    const breakdown = [...counts]
      .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
      .map(([category, count]) => `${category}=${String(count)}`)
      .join(", ");
    const candidates = unreadable
      .map(
        ({ pid, diagnostic }) =>
          `${String(pid)}=${sanitizedTokenReadFailure(diagnostic)}`,
      )
      .sort((left, right) => compareUnicodeCodePoints(left, right));
    return {
      cleaned: false,
      reason: `process ownership token could not be read for ${String(unreadable.length)} live process(es): ${breakdown}; live candidates ${candidates.join(", ")}`,
      failures,
      ...unverifiedEntry,
    };
  }
  return {
    cleaned: false,
    reason: "process ownership could not be revalidated",
    failures,
    ...unverifiedEntry,
  };
};

const sanitizedTokenReadFailure = (diagnostic: string | undefined): string => {
  if (diagnostic === "run_token_missing") return diagnostic;
  if (diagnostic === "environment_unavailable") return diagnostic;
  if (diagnostic === "platform_binary_environment_withheld") return diagnostic;
  if (diagnostic === "restricted_process_environment_withheld")
    return diagnostic;
  const environmentErrno = /^(EACCES|EPERM|ENOENT|ESRCH):/u.exec(
    diagnostic ?? "",
  );
  if (environmentErrno?.[1] !== undefined)
    return `environment_errno_${environmentErrno[1]}`;
  if (diagnostic === "apple_vector_unavailable") return diagnostic;
  if (diagnostic === "ambiguous_environment_boundary") return diagnostic;
  if (diagnostic === "malformed_procargs") return diagnostic;
  if (diagnostic === "process_identity_changed_during_token_read")
    return diagnostic;
  if (diagnostic === "process_not_in_snapshot") return diagnostic;
  const processTableFailure = /^process_table_failed_(\d+)$/u.exec(
    diagnostic ?? "",
  );
  if (processTableFailure?.[1] !== undefined)
    return `process_table_errno_${processTableFailure[1]}`;
  const sysctlFailure = /^sysctl_failed_(\d+)$/u.exec(diagnostic ?? "");
  if (sysctlFailure?.[1] !== undefined)
    return `sysctl_errno_${sysctlFailure[1]}`;
  if (diagnostic === "reader_failure") return diagnostic;
  if (diagnostic === "duplicate_run_token") return diagnostic;
  if (diagnostic === "invalid_run_token_encoding") return diagnostic;
  return "other_unavailable";
};

interface ProcessOwnershipValidation {
  readonly failures: readonly ProcessOwnershipValidationFailure[];
  readonly members: readonly ProcessTableEntry[];
  readonly refreshedProcesses?: readonly ProcessTableEntry[];
}

/** A fresh table may reveal another group after the bounded plan was built. */
const reconcileRefreshedSweep = async (
  validation: ProcessOwnershipValidation,
  ownership: OwnedProcessGroup,
  plannedGroups: ReadonlySet<number>,
  host: ProcessOwnershipHost,
  sweepBudget: OwnershipSweepBudget,
): Promise<
  | OwnedCleanupRefresh
  | ProcessCleanupFailure
  | {
      readonly failures: readonly ProcessOwnershipValidationFailure[];
      readonly unverified: readonly OwnershipSweepUnverifiedProcess[];
    }
  | undefined
> => {
  const refreshed = validation.refreshedProcesses;
  if (refreshed === undefined || ownership.sweepTokenOwnedProcesses !== true)
    return undefined;
  const newCandidates = new Set(
    refreshed
      .filter(({ processGroupId }) => !plannedGroups.has(processGroupId))
      .map(({ pid }) => pid),
  );
  if (newCandidates.size === 0) return undefined;
  const scan = await scanTokenOwnedProcesses(
    refreshed,
    ownership.runId,
    host,
    ownership.captureBaseline,
    ownership,
    sweepBudget,
  );
  if ("cleaned" in scan) return scan;
  const unplannedPids = new Set(
    scan.processes
      .filter(({ processGroupId }) => !plannedGroups.has(processGroupId))
      .map(({ pid }) => pid),
  );
  const failures = scan.failures.filter(({ pid }) => unplannedPids.has(pid));
  const newOwned = scan.owned.filter(
    ({ processGroupId }) => !plannedGroups.has(processGroupId),
  );
  if (newOwned.length > 0) {
    const refreshFailures = [...scan.failures];
    for (const failure of validation.failures)
      mergeProcessOwnershipFailure(refreshFailures, failure);
    for (const { pid } of newOwned)
      mergeProcessOwnershipFailure(refreshFailures, {
        pid,
        reason: "process-identity-unavailable",
        diagnostic:
          "process-group membership kept changing during bounded cleanup planning",
      });
    return {
      kind: "refresh",
      processes: scan.processes,
      unverified: scan.unverified,
      failures: refreshFailures,
    };
  }
  return { failures, unverified: scan.unverified };
};

/** Membership belongs to the fresh process table, not the earlier PID array. */
const validateProcessGroupMembers = async (
  processGroupId: number,
  initialMembers: readonly ProcessTableEntry[],
  runId: string,
  host: ProcessOwnershipHost,
  expectedIdentities: ReadonlyMap<number, string | null>,
): Promise<ProcessOwnershipValidation> => {
  let members = initialMembers;
  let refreshedProcesses: readonly ProcessTableEntry[] | undefined;
  for (let attempt = 0; attempt < TOKEN_READ_RETRY_ATTEMPTS; attempt++) {
    const validation = await validateProcessOwnership(
      members,
      runId,
      host,
      expectedIdentities,
    );
    refreshedProcesses = validation.refreshedProcesses ?? refreshedProcesses;
    if (
      validation.failures.length > 0 ||
      validation.refreshedProcesses === undefined
    )
      return {
        ...validation,
        ...(refreshedProcesses === undefined ? {} : { refreshedProcesses }),
      };
    const refreshedMembers = validation.refreshedProcesses.filter(
      (entry) => entry.processGroupId === processGroupId,
    );
    const validatedPids = new Set(validation.members.map(({ pid }) => pid));
    if (refreshedMembers.every(({ pid }) => validatedPids.has(pid)))
      return {
        failures: [],
        members: refreshedMembers,
        refreshedProcesses: validation.refreshedProcesses,
      };
    members = refreshedMembers;
  }
  return {
    members,
    ...(refreshedProcesses === undefined ? {} : { refreshedProcesses }),
    failures: members.map(({ pid }) => ({
      pid,
      reason: "process-identity-unavailable",
      diagnostic:
        "process-group membership kept changing during ownership validation",
    })),
  };
};

const validateProcessOwnership = async (
  members: readonly ProcessTableEntry[],
  runId: string,
  host: ProcessOwnershipHost,
  expectedIdentities: ReadonlyMap<number, string | null> = new Map(),
): Promise<ProcessOwnershipValidation> => {
  const failures: ProcessOwnershipValidationFailure[] = [];
  let validatedMembers = members;
  let refreshedProcesses: readonly ProcessTableEntry[] | undefined;
  const retainRecheck = (recheck: ProcessOwnershipRecheck): void => {
    failures.push(...recheck.failures);
    if (recheck.processes !== undefined) {
      refreshedProcesses = recheck.processes;
      const livePids = new Set(refreshedProcesses.map(({ pid }) => pid));
      validatedMembers = validatedMembers.filter(({ pid }) =>
        livePids.has(pid),
      );
    }
  };
  if (expectedIdentities.size > 0 && host.processIdentities !== undefined) {
    const expectedMembers = members.filter(({ pid }) =>
      expectedIdentities.has(pid),
    );
    const observed = await host.processIdentities(expectedMembers);
    const identityFailures: ProcessOwnershipValidationFailure[] = [];
    for (const member of expectedMembers) {
      const expected = expectedIdentities.get(member.pid);
      const current = observed.get(member.pid);
      if (
        expected === null ||
        current?.state !== "readable" ||
        current.identity !== expected
      ) {
        identityFailures.push({
          pid: member.pid,
          reason: "process-identity-unavailable",
          diagnostic:
            "process identity changed or became unavailable before signal",
        });
      }
    }
    retainRecheck(await recheckOwnershipFailures(identityFailures, host));
  }
  retainRecheck(await processRunTokenFailures(validatedMembers, runId, host));
  if (
    failures.length === 0 &&
    expectedIdentities.size > 0 &&
    host.processIdentities !== undefined
  ) {
    const expectedMembers = validatedMembers.filter(({ pid }) =>
      expectedIdentities.has(pid),
    );
    const observed = await host.processIdentities(expectedMembers);
    const identityFailures: ProcessOwnershipValidationFailure[] = [];
    for (const member of expectedMembers) {
      const expected = expectedIdentities.get(member.pid);
      const current = observed.get(member.pid);
      if (
        expected !== null &&
        current?.state === "readable" &&
        current.identity === expected
      )
        continue;
      identityFailures.push({
        pid: member.pid,
        reason: "process-identity-unavailable",
        diagnostic:
          "process identity changed or became unavailable during token validation",
      });
    }
    retainRecheck(await recheckOwnershipFailures(identityFailures, host));
  }
  return {
    failures,
    members: validatedMembers,
    ...(refreshedProcesses === undefined ? {} : { refreshedProcesses }),
  };
};

interface ProcessOwnershipRecheck {
  readonly failures: readonly ProcessOwnershipValidationFailure[];
  readonly processes?: readonly ProcessTableEntry[];
}

const processRunTokenFailures = async (
  members: readonly ProcessTableEntry[],
  runId: string,
  host: ProcessOwnershipHost,
): Promise<ProcessOwnershipRecheck> => {
  const failures: ProcessOwnershipValidationFailure[] = [];
  for await (const { process: member, observation } of readProcessRunTokens(
    host,
    members,
  )) {
    const validation = classifyProcessRunToken(observation, runId);
    if (validation.state === "owned") continue;
    if (validation.state === "foreign") {
      failures.push({ pid: member.pid, reason: "run-token-mismatch" });
      continue;
    }
    failures.push({
      pid: member.pid,
      reason: "environment-unreadable",
      diagnostic: validation.reason,
    });
  }
  return recheckOwnershipFailures(failures, host);
};

/**
 * Take a fresh liveness snapshot after each ownership-read phase. Only an
 * absent or zombie PID resolves an unavailable observation; an explicitly
 * foreign token remains a failure. Retain confirmed exits for signaling
 * consumers. Never reuse this snapshot across identity/token reads.
 */
const recheckOwnershipFailures = async (
  failures: readonly ProcessOwnershipValidationFailure[],
  host: ProcessOwnershipHost,
): Promise<ProcessOwnershipRecheck> => {
  if (!failures.some(({ reason }) => reason !== "run-token-mismatch"))
    return { failures };
  try {
    let processes = await host.listProcesses();
    const isDarwin = (host.platform ?? process.platform) === "darwin";
    for (
      let attempt = 0;
      isDarwin &&
      attempt < TOKEN_READ_RETRY_ATTEMPTS &&
      processes.some(
        ({ pid, state }) =>
          failures.some(
            (failure) =>
              failure.pid === pid && failure.reason !== "run-token-mismatch",
          ) && state.slice(1).includes("E"),
      );
      attempt += 1
    ) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, TOKEN_READ_RETRY_DELAY_MS),
      );
      processes = await host.listProcesses();
    }
    const liveEntries = liveProcesses(processes);
    const live = new Set(liveEntries.map(({ pid }) => pid));
    return {
      failures: failures.filter(
        ({ pid, reason }) => reason === "run-token-mismatch" || live.has(pid),
      ),
      processes: liveEntries,
    };
  } catch (cause: unknown) {
    return {
      failures: failures.map((failure) =>
        failure.reason === "run-token-mismatch"
          ? failure
          : {
              ...failure,
              diagnostic: `${failure.diagnostic}; process liveness recheck failed: ${errorMessage(cause)}`,
            },
      ),
    };
  }
};

interface TokenOwnedProcessFacts {
  readonly processes: readonly ProcessTableEntry[];
  readonly owned: readonly ProcessTableEntry[];
  readonly failures: readonly ProcessOwnershipValidationFailure[];
  readonly unverified: readonly OwnershipSweepUnverifiedProcess[];
  readonly identities: ReadonlyMap<number, string | null>;
}

type TokenOwnedProcessScan = TokenOwnedProcessFacts | ProcessCleanupFailure;

interface TokenOwnedSnapshotScan extends TokenOwnedProcessFacts {
  readonly observedIdentities: ReadonlyMap<number, ProcessIdentityObservation>;
  readonly refreshedProcesses?: readonly ProcessTableEntry[];
}

/** One cleanup call owns the discovery budget across every scan and replan. */
interface OwnershipSweepBudget {
  remainingRefreshes: number;
}

/** One sweep candidate whose run token could not be read. */
interface UnreadableTokenCandidate {
  readonly process: ProcessTableEntry;
  readonly diagnostic: string;
}

const TOKEN_READ_RETRY_ATTEMPTS = 3;
const TOKEN_READ_RETRY_DELAY_MS = 40;

/** Darwin reports this when the kernel withholds a platform binary's environment. */
const PLATFORM_BINARY_ENVIRONMENT_WITHHELD =
  "platform_binary_environment_withheld";
/** Darwin reports this when the kernel withholds a restricted process environment. */
const RESTRICTED_PROCESS_ENVIRONMENT_WITHHELD =
  "restricted_process_environment_withheld";

const currentProcessUid = (): number | undefined =>
  typeof process.getuid === "function" ? process.getuid() : undefined;

/**
 * Whether the operating system provably withheld this candidate's run token:
 * current macOS omits the environment of Apple platform binaries and
 * CS_RESTRICT processes from KERN_PROCARGS2, and fails with EINVAL for
 * processes owned by another account. These classes cannot be token-verified
 * by this caller. An unrelated candidate is recorded as unverified instead
 * of failing an otherwise clean capture; every related or otherwise
 * unreadable candidate stays fail-closed.
 */
const environmentWithheldFromInspection = (
  entry: ProcessTableEntry,
  diagnostic: string,
): boolean => {
  const uid = currentProcessUid();
  if (uid !== undefined && entry.uid !== undefined && entry.uid !== uid)
    return true;
  return (
    diagnostic === PLATFORM_BINARY_ENVIRONMENT_WITHHELD ||
    diagnostic === RESTRICTED_PROCESS_ENVIRONMENT_WITHHELD
  );
};

/** The sweep owns refreshed membership, including rows its exit checks discover. */
const scanTokenOwnedProcesses = async (
  initialProcesses: readonly ProcessTableEntry[],
  runId: string,
  host: ProcessOwnershipHost,
  captureBaseline?: ProcessOwnershipBaseline,
  relation?: OwnershipSweepRelation,
  budget: OwnershipSweepBudget = {
    remainingRefreshes: TOKEN_READ_RETRY_ATTEMPTS - 1,
  },
): Promise<TokenOwnedProcessScan> => {
  let processes = initialProcesses;
  const identities = new Map<number, string | null>();
  const unverified: OwnershipSweepUnverifiedProcess[] = [];
  for (;;) {
    const scan = await scanTokenOwnedProcessSnapshot(
      processes,
      runId,
      host,
      captureBaseline,
      relation,
      identities,
    );
    if ("cleaned" in scan) return withUnverifiedObservations(scan, unverified);
    for (const [pid, identity] of scan.identities)
      if (!identities.has(pid)) identities.set(pid, identity);
    mergeUnverifiedProcesses(unverified, scan.unverified);
    const refreshed = scan.refreshedProcesses;
    if (refreshed === undefined) return { ...scan, unverified };
    const previous = new Map(processes.map((entry) => [entry.pid, entry]));
    const excluded = refreshed.filter(({ pid }) => !scan.identities.has(pid));
    const currentExcludedIdentities =
      excluded.length > 0 && host.processIdentities !== undefined
        ? await host.processIdentities(excluded)
        : new Map<number, ProcessIdentityObservation>();
    const discovered = refreshed.filter(
      ({ pid, parentPid, processGroupId }) => {
        const before = previous.get(pid);
        if (
          before === undefined ||
          before.parentPid !== parentPid ||
          before.processGroupId !== processGroupId
        )
          return true;
        if (scan.identities.has(pid)) return false;
        const expected = scan.observedIdentities.get(pid);
        const current = currentExcludedIdentities.get(pid);
        return (
          expected?.state !== "readable" ||
          current?.state !== "readable" ||
          expected.identity !== current.identity
        );
      },
    );
    const live = new Map(refreshed.map((entry) => [entry.pid, entry]));
    const result = {
      ...scan,
      processes: refreshed,
      owned: scan.owned.flatMap(({ pid, processGroupId }) => {
        const entry = live.get(pid);
        return entry?.processGroupId === processGroupId ? [entry] : [];
      }),
      failures: scan.failures.filter(({ pid }) => live.has(pid)),
      unverified,
    };
    if (discovered.length === 0) return result;
    if (budget.remainingRefreshes === 0) {
      const failures = [...result.failures];
      for (const { pid } of discovered)
        mergeProcessOwnershipFailure(failures, {
          pid,
          reason: "process-identity-unavailable",
          diagnostic: "processes kept changing during bounded ownership sweep",
        });
      return { ...result, failures };
    }
    budget.remainingRefreshes--;
    processes = refreshed;
  }
};

const scanTokenOwnedProcessSnapshot = async (
  processes: readonly ProcessTableEntry[],
  runId: string,
  host: ProcessOwnershipHost,
  captureBaseline?: ProcessOwnershipBaseline,
  relation?: OwnershipSweepRelation,
  expectedIdentities: ReadonlyMap<number, string | null> = new Map(),
): Promise<TokenOwnedSnapshotScan | ProcessCleanupFailure> => {
  let refreshedProcesses: readonly ProcessTableEntry[] | undefined;
  let candidates = processes;
  let candidateIdentities: ReadonlyMap<number, ProcessIdentityObservation> =
    new Map();
  if (host.processIdentities !== undefined) {
    const current = await host.processIdentities(processes);
    candidateIdentities = current;
    if (captureBaseline !== undefined) {
      const baseline = new Map(
        captureBaseline.map(({ pid, identity }) => [pid, identity]),
      );
      candidates = processes.filter((process) => {
        const before = baseline.get(process.pid);
        const now = current.get(process.pid);
        return !(
          before !== undefined &&
          before !== null &&
          now?.state === "readable" &&
          now.identity === before
        );
      });
    }
  }
  const failures: ProcessOwnershipValidationFailure[] = [];
  // Keep start identity separate from token proof, including candidates whose
  // missing token may recover during later group validation.
  const scanIdentities = new Map<number, string | null>(
    candidates.map(({ pid }) => {
      const identity = candidateIdentities.get(pid);
      return [
        pid,
        expectedIdentities.has(pid)
          ? (expectedIdentities.get(pid) ?? null)
          : identity?.state === "readable"
            ? identity.identity
            : null,
      ];
    }),
  );
  if (captureBaseline !== undefined && host.processIdentities !== undefined) {
    const stableCandidates: ProcessTableEntry[] = [];
    const identityFailures: ProcessOwnershipValidationFailure[] = [];
    for (const process of candidates) {
      if (candidateIdentities.get(process.pid)?.state === "readable") {
        stableCandidates.push(process);
        continue;
      }
      identityFailures.push({
        pid: process.pid,
        reason: "process-identity-unavailable",
        diagnostic: "process identity was unavailable during token scan",
      });
    }
    const recheck = await recheckOwnershipFailures(identityFailures, host);
    failures.push(...recheck.failures);
    refreshedProcesses = recheck.processes ?? refreshedProcesses;
    candidates = stableCandidates;
  }
  const owned: ProcessTableEntry[] = [];
  const recordOwned = (process: ProcessTableEntry): void => {
    owned.push(process);
  };
  const unreadable: UnreadableTokenCandidate[] = [];
  for await (const { process, observation } of readProcessRunTokens(
    host,
    candidates,
  )) {
    const validation = classifyProcessRunToken(observation, runId);
    if (validation.state === "owned") recordOwned(process);
    else if (validation.state === "unavailable")
      unreadable.push({ process, diagnostic: validation.reason });
  }
  const settlement = await settleUnreadableTokenCandidates(
    unreadable,
    runId,
    host,
    recordOwned,
  );
  const remaining = settlement.remaining;
  refreshedProcesses = settlement.processes ?? refreshedProcesses;
  const relatedPids = new Set<number>();
  const relatedGroupIds = new Set<number>();
  if (relation !== undefined) {
    relatedPids.add(relation.leaderPid);
    for (const descendant of descendantsOf([relation.leaderPid], processes))
      relatedPids.add(descendant.pid);
    relatedGroupIds.add(relation.processGroupId);
    for (const processGroupId of relation.sampledProcessGroupIds ?? [])
      if (Number.isSafeInteger(processGroupId) && processGroupId > 0)
        relatedGroupIds.add(processGroupId);
    for (const process of owned) relatedGroupIds.add(process.processGroupId);
  }
  const unverified: OwnershipSweepUnverifiedProcess[] = [];
  const strict: UnreadableTokenCandidate[] = [];
  const withheld: UnreadableTokenCandidate[] = [];
  for (const candidate of remaining) {
    const isRelated =
      relation === undefined ||
      relatedPids.has(candidate.process.pid) ||
      relatedGroupIds.has(candidate.process.processGroupId);
    if (
      !isRelated &&
      environmentWithheldFromInspection(candidate.process, candidate.diagnostic)
    ) {
      withheld.push(candidate);
      continue;
    }
    strict.push(candidate);
  }
  const finalTable = await readLiveProcessTable(host);
  const finalLive = finalTable.available
    ? new Set(finalTable.processes.map(({ pid }) => pid))
    : undefined;
  if (finalTable.available) refreshedProcesses = finalTable.processes;
  for (const candidate of strict) {
    if (finalLive !== undefined && !finalLive.has(candidate.process.pid))
      continue;
    failures.push({
      pid: candidate.process.pid,
      reason: "environment-unreadable",
      diagnostic: candidate.diagnostic,
    });
  }
  for (const candidate of withheld) {
    if (finalLive !== undefined && !finalLive.has(candidate.process.pid))
      continue;
    unverified.push({
      pid: candidate.process.pid,
      diagnostic: candidate.diagnostic,
    });
  }
  if (!finalTable.available)
    return {
      cleaned: false,
      reason: `process table could not be inspected after token scan: ${finalTable.reason}`,
      failures,
      ...(unverified.length === 0 ? {} : { unverified }),
    };
  if (candidates.length > 0 && host.processIdentities !== undefined) {
    const afterRead = await host.processIdentities(candidates);
    const stillOwned: ProcessTableEntry[] = [];
    const identityFailures: ProcessOwnershipValidationFailure[] = [];
    const ownedPids = new Set(owned.map(({ pid }) => pid));
    for (const process of candidates) {
      const before = candidateIdentities.get(process.pid);
      const current = afterRead.get(process.pid);
      if (
        before?.state === "readable" &&
        current?.state === "readable" &&
        current.identity === before.identity &&
        current.identity === scanIdentities.get(process.pid)
      ) {
        if (ownedPids.has(process.pid)) stillOwned.push(process);
        continue;
      }
      identityFailures.push({
        pid: process.pid,
        reason: "process-identity-unavailable",
        diagnostic:
          "process identity changed or became unavailable during token validation",
      });
    }
    const recheck = await recheckOwnershipFailures(identityFailures, host);
    refreshedProcesses = recheck.processes ?? refreshedProcesses;
    for (const failure of recheck.failures)
      mergeProcessOwnershipFailure(failures, failure);
    return {
      processes,
      observedIdentities: candidateIdentities,
      ...(refreshedProcesses === undefined ? {} : { refreshedProcesses }),
      owned: stillOwned,
      failures,
      unverified,
      identities: scanIdentities,
    };
  }
  return {
    processes,
    owned,
    failures,
    unverified,
    identities: scanIdentities,
    observedIdentities: candidateIdentities,
    ...(refreshedProcesses === undefined ? {} : { refreshedProcesses }),
  };
};

/**
 * Re-read run tokens for unresolved sweep candidates so transient exec and
 * exit states settle before classification. Each attempt revalidates
 * liveness, refreshes the diagnostic, and is bounded by a fixed attempt
 * budget; a still-unreadable candidate keeps its latest diagnostic.
 */
const settleUnreadableTokenCandidates = async (
  pending: readonly UnreadableTokenCandidate[],
  runId: string,
  host: ProcessOwnershipHost,
  recordOwned: (process: ProcessTableEntry) => void,
): Promise<{
  readonly remaining: readonly UnreadableTokenCandidate[];
  readonly processes?: readonly ProcessTableEntry[];
}> => {
  let remaining = pending;
  let processes: readonly ProcessTableEntry[] | undefined;
  for (
    let attempt = 0;
    attempt < TOKEN_READ_RETRY_ATTEMPTS && remaining.length > 0;
    attempt += 1
  ) {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, TOKEN_READ_RETRY_DELAY_MS),
    );
    const table = await readLiveProcessTable(host);
    if (table.available) processes = table.processes;
    const live = table.available
      ? new Set(table.processes.map(({ pid }) => pid))
      : undefined;
    const stillUnreadable: UnreadableTokenCandidate[] = [];
    const candidates = remaining
      .map(({ process }) => process)
      .filter(({ pid }) => live === undefined || live.has(pid));
    for await (const { process, observation } of readProcessRunTokens(
      host,
      candidates,
    )) {
      const validation = classifyProcessRunToken(observation, runId);
      if (validation.state === "owned") recordOwned(process);
      else if (validation.state === "unavailable")
        stillUnreadable.push({ process, diagnostic: validation.reason });
    }
    remaining = stillUnreadable;
  }
  return { remaining, ...(processes === undefined ? {} : { processes }) };
};
