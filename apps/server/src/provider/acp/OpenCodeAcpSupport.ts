import {
  type OpenCodeSettings,
  type ProviderApprovalDecision,
  type ProviderOptionSelection,
  type ProviderUserInputAnswers,
  type UserInputQuestion,
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

/** Local OpenCode 2.x uses ACP; OpenCode 1 and an explicit server URL stay on HTTP. */
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

/** `opencode --auto acp` for full-access; otherwise `opencode acp`. */
export function openCodeAcpSpawnArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  switch (runtimeMode) {
    case "full-access":
      return ["--auto", "acp"];
    default:
      return ["acp"];
  }
}

/** Spawn input for the OpenCode ACP stdio child. */
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

/** Build an ACP session runtime that speaks `opencode acp`. */
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

/** Map a T3 approval decision to the optionId OpenCode actually offered. */
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

/** Apply model plus advertised config options such as variant and agent. */
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

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function firstAnswer(value: unknown): string | undefined {
  if (typeof value === "string") {
    return nonEmpty(value);
  }
  if (Array.isArray(value)) {
    const first = value.find((entry): entry is string => typeof entry === "string");
    return first === undefined ? undefined : nonEmpty(first);
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  return undefined;
}

function choiceOptions(
  schema: EffectAcpSchema.ElicitationPropertySchema,
): Array<{ label: string; description: string; value: string }> {
  if (schema.type === "boolean") {
    return [
      { label: "Yes", description: "Yes", value: "true" },
      { label: "No", description: "No", value: "false" },
    ];
  }
  if (schema.type === "string") {
    if (schema.oneOf && schema.oneOf.length > 0) {
      return schema.oneOf.map((option) => ({
        label: option.title,
        description: option.title,
        value: option.const,
      }));
    }
    if (schema.enum && schema.enum.length > 0) {
      return schema.enum.map((value) => ({
        label: value,
        description: value,
        value,
      }));
    }
  }
  if (schema.type === "array") {
    if ("enum" in schema.items) {
      return schema.items.enum.map((value) => ({
        label: value,
        description: value,
        value,
      }));
    }
    return schema.items.anyOf.map((option) => ({
      label: option.title,
      description: option.title,
      value: option.const,
    }));
  }
  return [];
}

function elicitationContentValue(
  value: unknown,
  schema: EffectAcpSchema.ElicitationPropertySchema | undefined,
): EffectAcpSchema.ElicitationContentValue | undefined {
  if (schema?.type === "array") {
    const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
    const values = raw
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return values.length > 0 ? values : undefined;
  }
  if (schema?.type === "boolean") {
    if (typeof value === "boolean") {
      return value;
    }
    const text = firstAnswer(value);
    if (text === "true") {
      return true;
    }
    if (text === "false") {
      return false;
    }
    return undefined;
  }
  if (schema?.type === "integer" || schema?.type === "number") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return schema.type === "integer" ? Math.trunc(value) : value;
    }
    const text = firstAnswer(value);
    if (text === undefined) {
      return undefined;
    }
    const parsed = schema.type === "integer" ? Number.parseInt(text, 10) : Number.parseFloat(text);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof value === "string") {
    return nonEmpty(value);
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  return undefined;
}

/** Turn an ACP elicitation request into T3 user-input questions. */
export function extractOpenCodeElicitationQuestions(
  request: EffectAcpSchema.ElicitationRequest,
): ReadonlyArray<UserInputQuestion> {
  if (request.mode === "url") {
    return [
      {
        id: "continue",
        header: "OpenCode",
        question: `${request.message.trim()} ${request.url}`.trim(),
        options: [
          { label: "Continue", description: "Continue", value: "accept" },
          { label: "Cancel", description: "Cancel", value: "cancel" },
        ],
        allowCustomAnswer: false,
        multiSelect: false,
      },
    ];
  }

  const properties = request.requestedSchema.properties ?? {};
  const questions: Array<UserInputQuestion> = [];
  for (const [id, schema] of Object.entries(properties)) {
    if (!nonEmpty(id) || schema === undefined) {
      continue;
    }
    const question = nonEmpty(schema.title) ?? nonEmpty(schema.description) ?? id;
    const options = choiceOptions(schema);
    questions.push({
      id,
      header: nonEmpty(request.requestedSchema.title) ?? "OpenCode",
      question,
      options,
      allowCustomAnswer: options.length === 0,
      multiSelect: schema.type === "array",
    });
  }

  if (questions.length === 0) {
    return [
      {
        id: "response",
        header: "OpenCode",
        question: request.message.trim() || "OpenCode needs a response.",
        options: [],
        allowCustomAnswer: true,
        multiSelect: false,
      },
    ];
  }
  return questions;
}

/** Convert T3 answers into an ACP elicitation response that matches requestedSchema. */
export function makeOpenCodeElicitationResponse(
  request: EffectAcpSchema.ElicitationRequest,
  answers: ProviderUserInputAnswers,
): EffectAcpSchema.ElicitationResponse {
  if (request.mode === "url") {
    const decision = firstAnswer(answers.continue);
    return {
      action: decision === "accept" ? { action: "accept" as const } : { action: "cancel" as const },
    };
  }

  const content: { [key: string]: EffectAcpSchema.ElicitationContentValue } = {};
  const properties = request.requestedSchema.properties ?? {};
  for (const question of extractOpenCodeElicitationQuestions(request)) {
    const value = elicitationContentValue(answers[question.id], properties[question.id]);
    if (value !== undefined) {
      content[question.id] = value;
    }
  }
  const required = (request.requestedSchema.required ?? []).filter(
    (name): name is string => typeof name === "string" && name.trim().length > 0,
  );
  if (Object.keys(content).length === 0 || required.some((name) => !(name in content))) {
    return { action: { action: "cancel" } };
  }
  return { action: { action: "accept", content } };
}

export { OPENCODE_AUTH_METHOD_ID, OPENCODE_DRIVER_KIND };
