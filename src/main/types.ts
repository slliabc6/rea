import type { OptionalProviderLoadResult } from "../application/OptionalObservationProviders.js";

export interface RuntimeDependencies {
  readonly captureShutdown?: (shutdown: () => Promise<void>) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly serve: typeof import("@modelcontextprotocol/server/stdio").serveStdio;
  readonly writeStderr: (text: string) => void;
  readonly setExitCode: (code: number) => void;
  readonly registerShutdown: (handler: () => void) => () => void;
  readonly createServer?: typeof import("../server/createServer.js").createServer;
  readonly loadOptionalProviders?: () => Promise<OptionalProviderLoadResult>;
}
