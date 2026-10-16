import { readFile } from "node:fs/promises";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";

import { launcherIdentityFailure } from "./ProcessOwnershipIdentity.js";
import { descendantsOf, liveProcesses } from "./ProcessOwnershipProcessTree.js";
import { execFileOutput } from "./ExecFileOutput.js";
import {
  createDarwinProcessRunTokenReader,
  type DarwinProcessReaderCompiler,
} from "./DarwinProcessRunTokenReader.js";
import {
  classifyProcessRunToken,
  readProcessRunTokens,
} from "./ProcessRunTokenObservations.js";
import type {
  OwnedProcessGroup,
  ProcessGroupObservation,
  ProcessLineageObservation,
  ProcessOwnershipHost,
  ProcessIdentityObservation,
  ProcessOwnershipBaseline,
  ProcessTableEntry,
} from "./ProcessOwnership.js";

/** Observe multiple groups from one process snapshot and one token batch. */
export const observeOwnedProcessGroups = async (
  runId: string,
  processGroupIds: readonly number[],
  host: ProcessOwnershipHost = systemProcessOwnershipHost,
  signal?: AbortSignal,
): Promise<ReadonlyMap<number, ProcessGroupObservation>> => {
  signal?.throwIfAborted();
  const groupIds = [...new Set(processGroupIds)];
  if (groupIds.length === 0) return new Map();
  let table = await readLiveProcessTable(host, signal);
  if (!table.available) {
    const failure = {
      state: "unverifiable" as const,
      reason: `process group could not be inspected: ${table.reason}`,
    };
    return new Map(groupIds.map((groupId) => [groupId, failure]));
  }
  const observations = new Map<number, ProcessGroupObservation>();
  const pendingGroups = new Set(groupIds);
  for (let attempt = 0; attempt < OWNERSHIP_OBSERVATION_ATTEMPTS; attempt++) {
    const members = table.processes.filter(({ processGroupId }) =>
      pendingGroups.has(processGroupId),
    );
    for (const groupId of pendingGroups)
      observations.set(
        groupId,
        members.some(({ processGroupId }) => processGroupId === groupId)
          ? { state: "alive" }
          : { state: "empty" },
      );
    const unavailable: {
      readonly process: ProcessTableEntry;
      readonly reason: string;
    }[] = [];
    for await (const { process: member, observation } of readProcessRunTokens(
      host,
      members,
      signal,
    )) {
      if (!pendingGroups.has(member.processGroupId)) continue;
      const validation = classifyProcessRunToken(observation, runId);
      if (validation.state === "foreign") {
        observations.set(member.processGroupId, {
          state: "unverifiable",
          reason: "process ownership did not match",
        });
        pendingGroups.delete(member.processGroupId);
      } else if (validation.state === "unavailable") {
        unavailable.push({ process: member, reason: validation.reason });
      }
      if (pendingGroups.size === 0) break;
    }
    signal?.throwIfAborted();
    if (unavailable.length === 0 || pendingGroups.size === 0)
      return observations;
    const refreshed = await readLiveProcessTable(host, signal);
    for (const { process: member, reason } of unavailable) {
      if (!pendingGroups.has(member.processGroupId)) continue;
      if (
        refreshed.available &&
        !refreshed.processes.some(({ pid }) => pid === member.pid)
      )
        continue;
      observations.set(member.processGroupId, {
        state: "unverifiable",
        reason: `process ownership could not be revalidated for PID ${member.pid}: ${reason}${refreshed.available ? "" : `; process table could not be inspected: ${refreshed.reason}`}`,
      });
      pendingGroups.delete(member.processGroupId);
    }
    if (!refreshed.available || pendingGroups.size === 0) return observations;
    table = refreshed;
    // Exit proof settles only the old PID. The complete refreshed membership
    // still needs token validation before the remaining groups can be verified.
  }
  for (const groupId of pendingGroups)
    observations.set(groupId, {
      state: "unverifiable",
      reason:
        "process-group membership kept changing during bounded ownership observation",
    });
  return observations;
};

/**
 * Record the live launcher and descendant lineage after run-token validation.
 *
 * The observation is intentionally point-in-time. A verified empty descendant
 * list means no descendants were live during this observation, not that the
 * run never created a short-lived child.
 */
export const observeOwnedProcessLineage = async (
  ownership: OwnedProcessGroup,
  host: ProcessOwnershipHost = systemProcessOwnershipHost,
): Promise<ProcessLineageObservation> => {
  let table = await readLiveProcessTable(host);
  if (!table.available) {
    return unavailableLineage(
      ownership,
      `process table could not be inspected: ${table.reason}`,
    );
  }
  const descendantAnchors = new Set<number>([ownership.leaderPid]);
  for (let attempt = 0; attempt < OWNERSHIP_OBSERVATION_ATTEMPTS; attempt++) {
    const processes = table.processes;
    const launcher = processes.find(({ pid }) => pid === ownership.leaderPid);
    if (launcher === undefined)
      return unavailableLineage(ownership, "owned launcher is not live");
    const identityFailure = launcherIdentityFailure(launcher, ownership);
    if (identityFailure !== null)
      return unavailableLineage(ownership, identityFailure);
    const discovered = new Set(
      descendantsOf([...descendantAnchors], processes).map(({ pid }) => pid),
    );
    const descendants = processes.filter(
      ({ pid }) =>
        pid !== launcher.pid &&
        (descendantAnchors.has(pid) || discovered.has(pid)),
    );
    for (const { pid } of descendants) descendantAnchors.add(pid);
    const verifiedDescendants: ProcessTableEntry[] = [];
    const unavailable: { readonly pid: number; readonly reason: string }[] = [];
    for await (const { process: member, observation } of readProcessRunTokens(
      host,
      [launcher, ...descendants],
    )) {
      const validation = classifyProcessRunToken(observation, ownership.runId);
      if (validation.state === "foreign")
        return unavailableLineage(
          ownership,
          "process lineage contains an unowned or PID-reused process",
        );
      if (validation.state === "owned") {
        if (member.pid !== launcher.pid) verifiedDescendants.push(member);
      } else {
        unavailable.push({ pid: member.pid, reason: validation.reason });
      }
    }
    if (unavailable.length > 0) {
      const refreshed = await readLiveProcessTable(host);
      for (const { pid, reason } of unavailable) {
        if (
          refreshed.available &&
          !refreshed.processes.some((entry) => entry.pid === pid)
        ) {
          if (pid === launcher.pid)
            return unavailableLineage(
              ownership,
              "owned launcher exited during lineage validation",
            );
          continue;
        }
        return unavailableLineage(
          ownership,
          `process ownership could not be revalidated for PID ${pid}: ${reason}${refreshed.available ? "" : `; process table could not be inspected: ${refreshed.reason}`}`,
        );
      }
      if (refreshed.available) table = refreshed;
      continue;
    }
    return {
      status: "verified",
      observedAt: new Date().toISOString(),
      lineage: {
        runId: ownership.runId,
        launcherPid: launcher.pid,
        launcherParentPid: launcher.parentPid,
        processGroupId: launcher.processGroupId,
        descendants: verifiedDescendants
          .sort((left, right) => left.pid - right.pid)
          .map(({ pid, parentPid, processGroupId }) => ({
            pid,
            parentPid,
            processGroupId,
          })),
      },
    };
  }
  return unavailableLineage(
    ownership,
    "process lineage kept changing during bounded ownership observation",
  );
};

const OWNERSHIP_OBSERVATION_ATTEMPTS = 3;

const unavailableLineage = (
  ownership: OwnedProcessGroup,
  reason: string,
): Extract<ProcessLineageObservation, { readonly status: "unavailable" }> => ({
  status: "unavailable",
  observedAt: new Date().toISOString(),
  runId: ownership.runId,
  launcherPid: ownership.leaderPid,
  processGroupId: ownership.processGroupId,
  reason,
});

/** Parse the NUL-delimited Linux process environment without nameless keys. */
export const parseProcessEnvironment = (
  value: string,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    value
      .split("\0")
      .filter((entry) => entry.indexOf("=") > 0)
      .map((entry) => {
        const separator = entry.indexOf("=");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
  );

/** Read Linux stat field 22, tolerating spaces and closing parentheses in comm. */
export const parseLinuxProcessStartTime = (
  value: string,
): string | undefined => {
  const commandEnd = value.lastIndexOf(")");
  if (commandEnd < 0) return undefined;
  const fields = value
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u);
  const startTime = fields[19];
  return startTime !== undefined && /^\d+$/u.test(startTime)
    ? startTime
    : undefined;
};

const isExpectedAbort = (
  cause: unknown,
  signal: AbortSignal | undefined,
): boolean =>
  signal?.aborted === true &&
  (cause === signal.reason ||
    (cause instanceof Error && cause.name === "AbortError"));

/** Create the operating-system process inspector for an explicit host context. */
export const createSystemProcessOwnershipHost = (
  platform: NodeJS.Platform = process.platform,
  hostEnvironment: NodeJS.ProcessEnv = process.env,
  options: {
    /** Override the compiler executable used by the Darwin native reader. */
    readonly darwinCompiler?: DarwinProcessReaderCompiler;
    /** Override the caller-owned module cache used compiling that helper. */
    readonly darwinModuleCachePath?: string;
    /** Deadline for Darwin ownership-helper compilation. */
    readonly compileTimeoutMs?: number;
  } = {},
): ProcessOwnershipHost => {
  const darwinModuleCachePath =
    options.darwinModuleCachePath ??
    hostEnvironment.REA_DARWIN_MODULE_CACHE_PATH;
  const swiftcPath = hostEnvironment.REA_DARWIN_SWIFTC_PATH;
  const darwinCompiler =
    options.darwinCompiler ??
    (swiftcPath === undefined || swiftcPath === ""
      ? undefined
      : {
          kind: "swiftc" as const,
          executable: swiftcPath,
          sdkRoot: hostEnvironment.SDKROOT ?? "",
        });
  const darwinTokens =
    platform === "darwin"
      ? createDarwinProcessRunTokenReader({
          ...(darwinCompiler === undefined ? {} : { compiler: darwinCompiler }),
          ...(darwinModuleCachePath === undefined
            ? {}
            : { moduleCachePath: darwinModuleCachePath }),
          ...(options.compileTimeoutMs === undefined
            ? { environment: hostEnvironment }
            : { compileTimeoutMs: options.compileTimeoutMs }),
        })
      : undefined;
  const listProcesses = async (signal?: AbortSignal) => {
    if (platform === "win32") return [];
    const { stdout, processId } = await execFileOutput(
      "ps",
      ["-axo", "pid=,ppid=,pgid=,uid=,stat=,command="],
      {
        env: hostEnvironment,
        captureProcessId: true,
        ...(signal === undefined ? {} : { signal }),
      },
    );
    return (
      stdout
        .split("\n")
        .map((line) =>
          /\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)/u.exec(line),
        )
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => ({
          pid: Number(match[1]),
          parentPid: Number(match[2]),
          processGroupId: Number(match[3]),
          uid: Number(match[4]),
          state: match[5] ?? "",
          command: match[6] ?? "",
        }))
        // ps produced this row while its own invocation was alive. Exclude only
        // that collector from its snapshot, without guessing by command names or
        // treating its PID as current ownership after the invocation exits.
        .filter(
          ({ pid, parentPid }) =>
            pid !== processId || parentPid !== process.pid,
        )
    );
  };
  const processIdentities: NonNullable<
    ProcessOwnershipHost["processIdentities"]
  > = async (processes, signal) => {
    if (processes.length === 0) return new Map();
    if (platform === "linux")
      return new Map<number, ProcessIdentityObservation>(
        await Promise.all(
          processes.map(async ({ pid }) => {
            try {
              const stat = await readFile(`/proc/${String(pid)}/stat`, {
                encoding: "utf8",
                ...(signal === undefined ? {} : { signal }),
              });
              const identity = parseLinuxProcessStartTime(stat);
              return [
                pid,
                identity === undefined
                  ? ({
                      state: "unavailable",
                      reason: "malformed_proc_stat",
                    } as const)
                  : ({
                      state: "readable",
                      identity: `linux-starttime:${identity}`,
                    } as const),
              ] as const;
            } catch (cause: unknown) {
              if (isExpectedAbort(cause, signal)) throw cause;
              return [
                pid,
                { state: "unavailable", reason: errorMessage(cause) } as const,
              ] as const;
            }
          }),
        ),
      );
    if (darwinTokens === undefined) return new Map();
    try {
      return await darwinTokens.identities(processes, signal);
    } catch (cause: unknown) {
      if (isExpectedAbort(cause, signal)) throw cause;
      const reason = errorMessage(cause);
      return new Map(
        processes.map(({ pid }) => [
          pid,
          { state: "unavailable", reason } as const,
        ]),
      );
    }
  };
  const captureBaseline = async (
    signal?: AbortSignal,
  ): Promise<ProcessOwnershipBaseline> => {
    if (platform !== "linux" && darwinTokens === undefined) return [];
    const processes = liveProcesses(await listProcesses(signal));
    let identities = await processIdentities(processes, signal);
    const unreadable = processes.filter(
      ({ pid }) => identities.get(pid)?.state !== "readable",
    );
    if (unreadable.length > 0) {
      const stillLive = liveProcesses(await listProcesses(signal)).filter(
        ({ pid }) => unreadable.some((entry) => entry.pid === pid),
      );
      const retried = await processIdentities(stillLive, signal);
      identities = new Map([...identities, ...retried]);
      const unresolved = stillLive.filter(
        ({ pid }) => identities.get(pid)?.state !== "readable",
      );
      const liveAfterRetry = liveProcesses(await listProcesses(signal));
      const stillUnresolved = unresolved.filter(({ pid }) =>
        liveAfterRetry.some((entry) => entry.pid === pid),
      );
      if (stillUnresolved.length > 0)
        throw new Error(
          `process identity snapshot is unavailable for ${String(stillUnresolved.length)} live processes`,
        );
    }
    return processes.map(({ pid }) => {
      const observation = identities.get(pid);
      return {
        pid,
        identity:
          observation?.state === "readable" ? observation.identity : null,
      };
    });
  };
  return {
    platform,
    prepare: async (signal) => {
      await darwinTokens?.prepare(signal);
      if (platform === "linux") {
        try {
          const processes = await listProcesses(signal);
          if (!processes.some(({ pid }) => pid === process.pid))
            throw new Error("ps did not report REA's current process");
        } catch (cause: unknown) {
          if (isExpectedAbort(cause, signal)) throw cause;
          const reason = `Linux process ownership inspection requires a procps-compatible ps on REA's PATH before launching a child: ${errorMessage(cause)}`;
          throw new AnalysisCapabilityUnavailableError(
            "process-ownership",
            "prepare_owned_process",
            reason,
            { cause, userMessage: reason },
          );
        }
      }
    },
    listProcesses,
    async environment(pid, signal) {
      signal?.throwIfAborted();
      if (platform === "linux")
        return parseProcessEnvironment(
          await readFile(`/proc/${pid}/environ`, { encoding: "utf8", signal }),
        );
      if (platform === "darwin") {
        const process = (await listProcesses(signal)).find(
          (entry) => entry.pid === pid,
        );
        if (process === undefined)
          throw new Error(`process ${String(pid)} is not live`);
        const observation = (await darwinTokens?.read([process], signal))?.get(
          pid,
        );
        if (observation === undefined || observation.state === "unavailable")
          throw new Error(
            observation?.reason ?? "process run token could not be read",
          );
        return observation.runId === undefined
          ? {}
          : { REA_PROCESS_RUN_ID: observation.runId };
      }
      const { stdout } = await execFileOutput(
        "ps",
        ["eww", "-p", String(pid)],
        {
          env: hostEnvironment,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      const observedEnvironment: Record<string, string> = {};
      for (const match of stdout.matchAll(
        /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=([^\s]*)/gu,
      )) {
        const name = match[1];
        if (name !== undefined) observedEnvironment[name] = match[2] ?? "";
      }
      return observedEnvironment;
    },
    async runTokens(processes, signal) {
      signal?.throwIfAborted();
      if (platform !== "darwin" || processes.length === 0) return new Map();
      try {
        return (await darwinTokens?.read(processes, signal)) ?? new Map();
      } catch (cause: unknown) {
        if (isExpectedAbort(cause, signal)) throw cause;
        void cause;
        return new Map(
          processes.map(({ pid }) => [
            pid,
            { state: "unavailable", reason: "reader_failure" } as const,
          ]),
        );
      }
    },
    ...(platform !== "linux" && darwinTokens === undefined
      ? {}
      : {
          processIdentities,
          captureBaseline,
          ...(darwinTokens === undefined ? {} : { close: darwinTokens.close }),
        }),
    signalGroup(processGroupId, signal) {
      process.kill(-processGroupId, signal);
    },
  };
};

export const systemProcessOwnershipHost = createSystemProcessOwnershipHost();

/**
 * Observe a live PID's start identity, optionally binding it to an owned run.
 * Token validation is bracketed by identity reads so PID reuse cannot supply
 * the first identity of a different process for an owned launch.
 */
export const observeProcessStartIdentity = async (
  pid: number,
  host: ProcessOwnershipHost = systemProcessOwnershipHost,
  expectedRunId?: string,
): Promise<ProcessIdentityObservation | undefined> => {
  const process = (await host.listProcesses()).find(
    (entry) => entry.pid === pid,
  );
  if (process === undefined || liveProcesses([process]).length === 0)
    return undefined;
  if (host.processIdentities === undefined)
    return { state: "unavailable", reason: "process identity is unsupported" };
  const identity: ProcessIdentityObservation = (
    await host.processIdentities([process])
  ).get(pid) ?? {
    state: "unavailable",
    reason: "process identity was not returned",
  };
  if (expectedRunId === undefined || identity.state !== "readable")
    return identity;
  let owned = false;
  for await (const { observation } of readProcessRunTokens(host, [process])) {
    if (observation.state === "unavailable")
      return {
        state: "unavailable",
        reason: `process ownership token could not be read for PID ${String(pid)}: ${observation.reason}`,
      };
    if (observation.runId !== expectedRunId)
      return {
        state: "unavailable",
        reason: `process ownership token did not match the captured run for PID ${String(pid)}`,
      };
    owned = true;
  }
  if (!owned)
    return {
      state: "unavailable",
      reason: `process ownership token was not returned for PID ${String(pid)}`,
    };
  const confirmed = await observeProcessStartIdentity(pid, host);
  if (confirmed === undefined || confirmed.state !== "readable")
    return confirmed;
  return confirmed.identity === identity.identity
    ? identity
    : {
        state: "unavailable",
        reason: `process identity changed while validating the captured run token for PID ${String(pid)}`,
      };
};

/** Confirm whether the process that held an authenticated bridge has exited. */
export const observeProcessStartIdentityExit = async (
  pid: number,
  expectedIdentity: string,
  host: ProcessOwnershipHost = systemProcessOwnershipHost,
): Promise<"exited" | "present" | "unverified"> => {
  try {
    const observed = await observeProcessStartIdentity(pid, host);
    if (observed === undefined) return "exited";
    if (observed.state !== "readable") return "unverified";
    return observed.identity === expectedIdentity ? "present" : "exited";
  } catch {
    return "unverified";
  }
};

/** Revalidate a launch-time start identity immediately before signaling a PID. */
export const signalProcessWithStartIdentity = async (
  pid: number,
  expectedIdentity: string,
  signal: NodeJS.Signals,
  options: {
    readonly host?: ProcessOwnershipHost;
    readonly sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): Promise<"signaled" | "gone" | "identity-changed" | "unverified"> => {
  const host = options.host ?? systemProcessOwnershipHost;
  try {
    const observed = await observeProcessStartIdentity(pid, host);
    if (observed === undefined) return "gone";
    if (observed.state !== "readable") return "unverified";
    if (observed.identity !== expectedIdentity) return "identity-changed";
    (options.sendSignal ?? process.kill)(pid, signal);
    return "signaled";
  } catch {
    return "unverified";
  }
};

/** Prepare native token inspection before REA launches a captured child. */
export const prepareProcessOwnershipInspection = async (
  signal?: AbortSignal,
): Promise<void> => {
  await systemProcessOwnershipHost.prepare?.(signal);
};

/** Parsed liveness facts shared by cleanup and cancellable observations. */
export const readLiveProcessTable = async (
  host: ProcessOwnershipHost,
  signal?: AbortSignal,
): Promise<
  | {
      readonly available: true;
      readonly processes: readonly ProcessTableEntry[];
    }
  | { readonly available: false; readonly reason: string }
> => {
  signal?.throwIfAborted();
  try {
    const processes =
      signal === undefined
        ? await host.listProcesses()
        : await host.listProcesses(signal);
    signal?.throwIfAborted();
    return { available: true, processes: liveProcesses(processes) };
  } catch (cause: unknown) {
    signal?.throwIfAborted();
    return { available: false, reason: errorMessage(cause) };
  }
};

export const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
