import {
  type OpenCodeSettings,
  type ProviderApprovalDecision,
  type ProviderOptionSelection,
  ProviderDriverKind,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { isOpenCodeV2CliVersion } from "../opencodeRuntime.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const OPENCODE_DRIVER_KIND = ProviderDriverKind.make("opencode");
const OPENCODE_AUTH_METHOD_ID = "opencode-login";

type OpenCodeAcpRuntimeSettings = Pick<OpenCodeSettings, "binaryPath">;

export interface OpenCodeAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly openCodeSettings: OpenCodeAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

export function shouldUseOpenCodeAcp(input: {
  readonly serverUrl: string;
  readonly cliVersion: string | null;
}): boolean {
  return (
    input.serverUrl.trim().length === 0 &&
    input.cliVersion !== null &&
    isOpenCodeV2CliVersion(input.cliVersion)
  );
}

export function openCodeAcpSpawnArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  switch (runtimeMode) {
    case "full-access":
      return ["--auto", "acp"];
    default:
      return ["acp"];
  }
}

export function buildOpenCodeAcpSpawnInput(
  openCodeSettings: OpenCodeAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: openCodeSettings?.binaryPath || "opencode",
    args: [...openCodeAcpSpawnArgs(runtimeMode)],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeOpenCodeAcpRuntime = (
  input: OpenCodeAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildOpenCodeAcpSpawnInput(
          input.openCodeSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
        ),
        authMethodId: OPENCODE_AUTH_METHOD_ID,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function selectOpenCodePermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
): string | undefined {
  if (decision === "cancel") {
    return undefined;
  }
  const kind =
    decision === "accept" ? "allow_once" : decision === "decline" ? "reject_once" : "allow_always";
  const option = request.options.find((entry) => entry.kind === kind);
  const optionId = option?.optionId.trim();
  return optionId && optionId.length > 0 ? optionId : undefined;
}

interface OpenCodeAcpModelSelectionRuntime {
  readonly getConfigOptions: Effect.Effect<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export function applyOpenCodeAcpModelSelection<E>(input: {
  readonly runtime: OpenCodeAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly options?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const advertised = yield* input.runtime.getConfigOptions;
    const advertisedIds = new Set(advertised.map((option) => option.id));
    const model = input.model?.trim();
    if (model) {
      if (advertisedIds.has("model")) {
        yield* input.runtime.setConfigOption("model", model).pipe(Effect.mapError(input.mapError));
      } else {
        yield* input.runtime.setModel(model).pipe(Effect.mapError(input.mapError));
      }
    }

    for (const selection of input.options ?? []) {
      if (selection.id === "model" || !advertisedIds.has(selection.id)) {
        continue;
      }
      const value = selection.value;
      if (typeof value === "boolean") {
        yield* input.runtime
          .setConfigOption(selection.id, value)
          .pipe(Effect.mapError(input.mapError));
      } else if (typeof value === "string" && value.trim().length > 0) {
        yield* input.runtime
          .setConfigOption(selection.id, value)
          .pipe(Effect.mapError(input.mapError));
      }
    }
  });
}

export { OPENCODE_AUTH_METHOD_ID, OPENCODE_DRIVER_KIND };
