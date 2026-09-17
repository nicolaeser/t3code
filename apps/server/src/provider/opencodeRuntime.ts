import * as NodeURL from "node:url";

import type { ChatAttachment, ProviderApprovalDecision, RuntimeMode } from "@t3tools/contracts";
import {
  createOpencodeClient,
  type Agent,
  type Command,
  type FilePartInput,
  type Model,
  type OpencodeClient,
  type PermissionRuleset,
  type ProviderListResponse,
  type QuestionAnswer,
  type QuestionRequest,
} from "@opencode-ai/sdk/v2";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { isWindowsCommandNotFound } from "../processRunner.ts";
import { collectStreamAsString } from "./providerSnapshot.ts";
import * as NetService from "@t3tools/shared/Net";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const OPENCODE_EMPTY_CONFIG_CONTENT = "{}";

export const MINIMUM_OPENCODE_VERSION = "1.14.19";
const OPENCODE_HEALTH_TIMEOUT = "5 seconds";

const OpenCodeHealthSchema = Schema.Struct({
  healthy: Schema.Literal(true),
  version: Schema.String,
});
const decodeOpenCodeHealth = Schema.decodeUnknownEffect(OpenCodeHealthSchema);

export function resolveOpenCodeConfigContent(
  inputEnvironment: Readonly<Record<string, string | undefined>> | undefined,
  inheritedEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return (
    inputEnvironment?.OPENCODE_CONFIG_CONTENT ??
    inheritedEnvironment.OPENCODE_CONFIG_CONTENT ??
    OPENCODE_EMPTY_CONFIG_CONTENT
  );
}

export function resolveOpenCodeServerPassword(
  input: {
    readonly external: boolean;
    readonly serverPassword?: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  },
  inheritedEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (input.serverPassword !== undefined) {
    return input.serverPassword;
  }
  if (input.external) {
    return undefined;
  }
  return input.environment === undefined
    ? inheritedEnvironment.OPENCODE_SERVER_PASSWORD
    : input.environment.OPENCODE_SERVER_PASSWORD;
}

const DEFAULT_OPENCODE_SERVER_TIMEOUT_MS = 30_000;
const DEFAULT_HOSTNAME = "127.0.0.1";
const OPENCODE_SERVER_STARTUP_MAX_OUTPUT_CHARS = 64 * 1024;
const OPENCODE_SKILL_DISCOVERY_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export interface OpenCodeServerProcess {
  readonly url: string;
  readonly serverPassword?: string;
  readonly version: string;
  readonly isRunning: Effect.Effect<boolean>;
  readonly exitCode: Effect.Effect<number, never>;
}

export interface OpenCodeServerConnection {
  readonly url: string;
  readonly serverPassword?: string;
  readonly version: string;
  readonly exitCode: Effect.Effect<number, never> | null;
  readonly external: boolean;
}

const OPENCODE_RUNTIME_ERROR_TAG = "OpenCodeRuntimeError";
export class OpenCodeRuntimeError extends Data.TaggedError(OPENCODE_RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = (u: unknown): u is OpenCodeRuntimeError =>
    P.isTagged(u, OPENCODE_RUNTIME_ERROR_TAG);
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export function openCodeRuntimeErrorDetail(cause: unknown): string {
  if (OpenCodeRuntimeError.is(cause)) return cause.detail;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  if (cause && typeof cause === "object") {
    // SDK v2 throws { response, request, error? } shapes — extract what's useful
    const anyCause = cause as Record<string, unknown>;
    const status = (anyCause.response as { status?: number } | undefined)?.status;
    const body = anyCause.error ?? anyCause.data ?? anyCause.body;
    const encodedBody = encodeJsonStringForDiagnostics(body ?? cause);
    if (encodedBody) {
      return `status=${status ?? "?"} body=${encodedBody}`;
    }
  }
  return String(cause);
}

export const runOpenCodeSdk = <A>(
  operation: string,
  fn: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, OpenCodeRuntimeError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new OpenCodeRuntimeError({ operation, detail: openCodeRuntimeErrorDetail(cause), cause }),
  }).pipe(Effect.withSpan(`opencode.${operation}`));

/** True for valid semver 2.0.0 and newer. Invalid versions are not treated as 2.x. */
export function isOpenCodeV2CliVersion(version: string): boolean {
  return parseSemver(version) !== null && compareSemverVersions(version, "2.0.0") >= 0;
}

function isOpenCodeLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

/** Passwords travel only over HTTPS or loopback HTTP. */
export function openCodeV2CredentialUrlError(
  baseUrl: string,
  serverPassword: string | undefined,
): string | undefined {
  if (serverPassword === undefined || serverPassword.length === 0) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return "OpenCode server URL is invalid.";
  }
  if (url.protocol === "https:") {
    return undefined;
  }
  if (url.protocol === "http:" && isOpenCodeLoopbackHostname(url.hostname)) {
    return undefined;
  }
  return "OpenCode server passwords are only sent over HTTPS or loopback HTTP.";
}

const OpenCodeV2InfoSchema = Schema.Struct({
  version: Schema.String,
});
const decodeOpenCodeV2Info = Schema.decodeUnknownEffect(OpenCodeV2InfoSchema);

function openCodeBasicAuthHeader(serverPassword: string | undefined): Record<string, string> {
  if (serverPassword === undefined || serverPassword.length === 0) {
    return {};
  }
  return {
    Authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`, "utf8").toString("base64")}`,
  };
}

const fetchOpenCodeV2Json = (input: {
  readonly baseUrl: string;
  readonly path: string;
  readonly serverPassword?: string;
  readonly directory?: string;
}): Effect.Effect<unknown, OpenCodeRuntimeError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const url = new URL(input.path, input.baseUrl);
    const credentialError = openCodeV2CredentialUrlError(url.origin, input.serverPassword);
    if (credentialError) {
      return yield* new OpenCodeRuntimeError({
        operation: `v2.${input.path}`,
        detail: credentialError,
      });
    }
    if (input.directory) {
      url.searchParams.set("location[directory]", input.directory);
    }
    const headers = openCodeBasicAuthHeader(input.serverPassword);
    let request = HttpClientRequest.get(url.toString()).pipe(
      HttpClientRequest.setHeader("accept", "application/json"),
    );
    for (const [name, value] of Object.entries(headers)) {
      request = request.pipe(HttpClientRequest.setHeader(name, value));
    }
    const response = yield* client.execute(request).pipe(
      Effect.timeout(OPENCODE_HEALTH_TIMEOUT),
      Effect.mapError((cause) =>
        OpenCodeRuntimeError.is(cause)
          ? cause
          : new OpenCodeRuntimeError({
              operation: `v2.${input.path}`,
              detail: `Timed out or failed requesting ${input.path}: ${openCodeRuntimeErrorDetail(cause)}`,
              cause,
            }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* new OpenCodeRuntimeError({
        operation: `v2.${input.path}`,
        detail: `status=${response.status} body=${body.slice(0, 500)}`,
      });
    }
    return yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new OpenCodeRuntimeError({
            operation: `v2.${input.path}`,
            detail: openCodeRuntimeErrorDetail(cause),
            cause,
          }),
      ),
    );
  });

const fetchOpenCodeV2Info = (input: {
  readonly baseUrl: string;
  readonly serverPassword?: string;
}): Effect.Effect<string, OpenCodeRuntimeError, HttpClient.HttpClient> =>
  fetchOpenCodeV2Json({ ...input, path: "/api/info" }).pipe(
    Effect.flatMap((payload) =>
      decodeOpenCodeV2Info(payload).pipe(
        Effect.mapError(
          (cause) =>
            new OpenCodeRuntimeError({
              operation: "server.info",
              detail: `OpenCode server returned an invalid /api/info response. T3 Code requires OpenCode v${MINIMUM_OPENCODE_VERSION} or newer.`,
              cause,
            }),
        ),
      ),
    ),
    Effect.map((info) => info.version),
  );

function acceptOpenCodeVersion(
  version: string,
  operation: string,
): Effect.Effect<string, OpenCodeRuntimeError> {
  if (parseSemver(version) === null) {
    return Effect.fail(
      new OpenCodeRuntimeError({
        operation,
        detail: `OpenCode server returned an invalid version. T3 Code requires OpenCode v${MINIMUM_OPENCODE_VERSION} or newer.`,
      }),
    );
  }
  if (compareSemverVersions(version, MINIMUM_OPENCODE_VERSION) < 0) {
    return Effect.fail(
      new OpenCodeRuntimeError({
        operation,
        detail: `OpenCode v${version} is too old. Upgrade to v${MINIMUM_OPENCODE_VERSION} or newer.`,
      }),
    );
  }
  return Effect.succeed(version);
}

export const verifyOpenCodeServerVersion = Effect.fn("verifyOpenCodeServerVersion")(function* (
  client: OpencodeClient,
) {
  const healthOption = yield* runOpenCodeSdk("global.health", (signal) =>
    client.global.health({ signal }),
  ).pipe(Effect.timeoutOption(OPENCODE_HEALTH_TIMEOUT));
  if (Option.isNone(healthOption)) {
    return yield* new OpenCodeRuntimeError({
      operation: "global.health",
      detail: "Timed out while checking the OpenCode server version.",
    });
  }

  const health = yield* decodeOpenCodeHealth(healthOption.value.data).pipe(
    Effect.mapError(
      (cause) =>
        new OpenCodeRuntimeError({
          operation: "global.health",
          detail: `OpenCode server returned an invalid health response. T3 Code requires OpenCode v${MINIMUM_OPENCODE_VERSION} or newer.`,
          cause,
        }),
    ),
  );
  return yield* acceptOpenCodeVersion(health.version, "global.health");
});

const resolveOpenCodeServerVersion = (
  client: OpencodeClient,
  connection: {
    readonly baseUrl: string;
    readonly serverPassword?: string;
  },
): Effect.Effect<string, OpenCodeRuntimeError, HttpClient.HttpClient> => {
  const credentialError = openCodeV2CredentialUrlError(
    connection.baseUrl,
    connection.serverPassword,
  );
  if (credentialError) {
    return Effect.fail(
      new OpenCodeRuntimeError({
        operation: "server.info",
        detail: credentialError,
      }),
    );
  }
  const fromV2Info = fetchOpenCodeV2Info(connection).pipe(
    Effect.flatMap((version) => acceptOpenCodeVersion(version, "server.info")),
  );
  const fromV1Health = verifyOpenCodeServerVersion(client);
  // OpenCode 2 local serve prints a generated password. Prefer /api/info in
  // that case so we do not treat the v1 HTML fallback as a health payload.
  // OpenCode 1 has no password line; keep hitting /global/health first.
  return connection.serverPassword
    ? fromV2Info.pipe(Effect.catch(() => fromV1Health))
    : fromV1Health.pipe(Effect.catch(() => fromV2Info));
};

export interface OpenCodeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface OpenCodeInventory {
  readonly providerList: ProviderListResponse;
  readonly agents: ReadonlyArray<Agent>;
  readonly skills: ReadonlyArray<OpenCodeSkill>;
  readonly commands?: ReadonlyArray<OpenCodeSlashCommand>;
}

export type OpenCodeSlashCommand = Pick<Command, "name" | "description" | "source" | "hints">;

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Map OpenCode 2 `/api/{provider,model,agent,skill,command}` payloads onto the v1 inventory shape. */
export function openCodeInventoryFromV2Rest(input: {
  readonly providers: ReadonlyArray<unknown>;
  readonly models: ReadonlyArray<unknown>;
  readonly agents: ReadonlyArray<unknown>;
  readonly skills: ReadonlyArray<unknown>;
  readonly commands: ReadonlyArray<unknown>;
  readonly connected?: ReadonlyArray<string>;
  readonly defaultProviders?: ProviderListResponse["default"];
}): OpenCodeInventory {
  const providers = new Map<
    string,
    { id: string; name: string; models: { [key: string]: Model } }
  >();
  const connected: Array<string> = [];

  for (const item of input.providers) {
    const record = asRecord(item);
    const id = record ? readString(record, "id") : undefined;
    if (!id) continue;
    const name = (record ? readString(record, "name") : undefined) ?? id;
    providers.set(id, { id, name, models: {} });
    const activation = record ? readString(record, "activation") : undefined;
    const disabled = record?.disabled === true || activation === "disabled";
    if (!disabled) {
      connected.push(id);
    }
  }

  const explicitConnected = input.connected !== undefined;
  for (const item of input.models) {
    const record = asRecord(item);
    if (!record) continue;
    const providerID = readString(record, "providerID");
    const modelID = readString(record, "modelID") ?? readString(record, "id");
    const name = readString(record, "name") ?? modelID;
    if (!providerID || !modelID || !name) continue;
    let provider = providers.get(providerID);
    if (!provider) {
      provider = { id: providerID, name: providerID, models: {} };
      providers.set(providerID, provider);
      if (!explicitConnected) {
        connected.push(providerID);
      }
    }
    const variantsRecord = asRecord(record.variants);
    const variants = Array.isArray(record.variants)
      ? Object.fromEntries(
          record.variants
            .filter((variant): variant is string => typeof variant === "string")
            .map((variant) => [variant, {}]),
        )
      : (variantsRecord ?? {});
    provider.models[modelID] = {
      id: modelID,
      providerID,
      name,
      variants,
    } as Model;
  }

  const uniqueConnected = [
    ...new Set(
      explicitConnected
        ? (input.connected ?? [])
        : connected.length > 0 || providers.size > 0
          ? connected
          : [...providers.keys()],
    ),
  ];
  const providerList = {
    all: [...providers.values()],
    connected: uniqueConnected,
    default: input.defaultProviders ?? {},
  } as ProviderListResponse;

  const agents: Array<Agent> = [];
  for (const item of input.agents) {
    const record = asRecord(item);
    if (!record) continue;
    const name = readString(record, "id") ?? readString(record, "name");
    if (!name) continue;
    const mode = readString(record, "mode") ?? "primary";
    agents.push({
      name,
      mode: mode as Agent["mode"],
      hidden: record.hidden === true,
      permission: {},
      options: {},
    } as Agent);
  }

  const skills: Array<OpenCodeSkill> = [];
  for (const item of input.skills) {
    const record = asRecord(item);
    if (!record) continue;
    const name = readString(record, "name");
    const location = readString(record, "path") ?? readString(record, "location");
    if (!name || !location) continue;
    const description = readString(record, "description");
    skills.push(description ? { name, location, description } : { name, location });
  }

  const commands: Array<OpenCodeSlashCommand> = [];
  for (const item of input.commands) {
    const record = asRecord(item);
    const name = record ? readString(record, "name") : undefined;
    if (!name) continue;
    const description = record ? readString(record, "description") : undefined;
    const hints =
      record && Array.isArray(record.hints)
        ? record.hints.filter((hint): hint is string => typeof hint === "string")
        : [];
    const source = record ? readString(record, "source") : undefined;
    commands.push({
      name,
      hints,
      ...(source ? { source } : {}),
      ...(description ? { description } : {}),
    } as OpenCodeSlashCommand);
  }

  return { providerList, agents, skills, commands };
}

/** Decode `/api/provider` as an array, `{ data }`, or `{ all, connected, default }`. */
export function unwrapProviderCatalog(payload: unknown): {
  readonly providers: ReadonlyArray<unknown>;
  readonly connected?: ReadonlyArray<string>;
  readonly defaultProviders?: ProviderListResponse["default"];
} {
  if (Array.isArray(payload)) {
    return { providers: payload };
  }
  const record = asRecord(payload);
  if (!record) {
    return { providers: [] };
  }
  if (Array.isArray(record.data)) {
    return { providers: record.data };
  }
  if (Array.isArray(record.all)) {
    const connected = Array.isArray(record.connected)
      ? record.connected.filter((id): id is string => typeof id === "string")
      : undefined;
    return {
      providers: record.all,
      ...(connected !== undefined ? { connected } : {}),
      ...(record.default !== undefined
        ? { defaultProviders: record.default as ProviderListResponse["default"] }
        : {}),
    };
  }
  return { providers: [] };
}

/** Load models, agents, skills, and commands from OpenCode 2 REST list endpoints. */
export const loadOpenCodeV2Inventory = (input: {
  readonly baseUrl: string;
  readonly directory: string;
  readonly serverPassword?: string;
}): Effect.Effect<OpenCodeInventory, OpenCodeRuntimeError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const request = {
      baseUrl: input.baseUrl,
      ...(input.serverPassword !== undefined ? { serverPassword: input.serverPassword } : {}),
      directory: input.directory,
    };
    const [providersPayload, modelsPayload, agentsPayload, skillsPayload, commandsPayload] =
      yield* Effect.all(
        [
          fetchOpenCodeV2Json({ ...request, path: "/api/provider" }),
          fetchOpenCodeV2Json({ ...request, path: "/api/model" }),
          fetchOpenCodeV2Json({ ...request, path: "/api/agent" }),
          fetchOpenCodeV2Json({ ...request, path: "/api/skill" }),
          fetchOpenCodeV2Json({ ...request, path: "/api/command" }),
        ],
        { concurrency: "unbounded" },
      );

    const unwrapList = (payload: unknown) => {
      if (Array.isArray(payload)) return payload;
      const record = asRecord(payload);
      if (!record) return [];
      if (Array.isArray(record.data)) return record.data;
      if (Array.isArray(record.all)) return record.all;
      return [];
    };
    const providerCatalog = unwrapProviderCatalog(providersPayload);

    return openCodeInventoryFromV2Rest({
      providers: providerCatalog.providers,
      models: unwrapList(modelsPayload),
      agents: unwrapList(agentsPayload),
      skills: unwrapList(skillsPayload),
      commands: unwrapList(commandsPayload),
      ...(providerCatalog.connected !== undefined ? { connected: providerCatalog.connected } : {}),
      ...(providerCatalog.defaultProviders !== undefined
        ? { defaultProviders: providerCatalog.defaultProviders }
        : {}),
    });
  });

/** Command templates stay in OpenCode, which expands arguments and runs MCP prompts. */
export const loadOpenCodeCommands = (client: OpencodeClient) =>
  runOpenCodeSdk("command.list", (signal) => client.command.list(undefined, { signal })).pipe(
    Effect.map((result): ReadonlyArray<OpenCodeSlashCommand> =>
      (result.data ?? []).map(({ name, description, source, hints }) => ({
        name,
        ...(description === undefined ? {} : { description }),
        ...(source === undefined ? {} : { source }),
        hints,
      })),
    ),
  );

export interface ParsedOpenCodeModelSlug {
  readonly providerID: string;
  readonly modelID: string;
}

export interface OpenCodeSkill {
  readonly name?: string | null;
  readonly description?: string | null;
  readonly location?: string | null;
}

const OpenCodeSkillSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  location: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeOpenCodeSkillsCliOutputExit = Schema.decodeUnknownExit(
  Schema.fromJsonString(Schema.Array(OpenCodeSkillSchema)),
);

export interface OpenCodeRuntimeShape {
  /**
   * Spawns a local OpenCode server process. Its lifetime is bound to the caller's
   * `Scope.Scope` — the child is killed automatically when that scope closes.
   * Consumers that want a long-lived server must create and hold a scope explicitly
   * (see {@link Scope.make}) and close it when done.
   */
  readonly startOpenCodeServerProcess: (input: {
    readonly binaryPath: string;
    readonly directory: string;
    readonly serverPassword?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerProcess, OpenCodeRuntimeError, Scope.Scope>;
  /**
   * Returns a handle to either an externally-managed OpenCode server (when
   * `serverUrl` is provided — no lifetime is attached to the caller's scope) or a
   * freshly spawned local server whose lifetime is bound to the caller's scope.
   */
  readonly connectToOpenCodeServer: (input: {
    readonly binaryPath: string;
    readonly directory: string;
    readonly serverUrl?: string | null;
    readonly serverPassword?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerConnection, OpenCodeRuntimeError, Scope.Scope>;
  readonly runOpenCodeCommand: (input: {
    readonly binaryPath: string;
    readonly args: ReadonlyArray<string>;
    readonly environment?: NodeJS.ProcessEnv;
    readonly cwd?: string;
    readonly maxOutputBytes?: number;
  }) => Effect.Effect<OpenCodeCommandResult, OpenCodeRuntimeError>;
  readonly createOpenCodeSdkClient: (input: {
    readonly baseUrl: string;
    readonly directory: string;
    readonly serverPassword?: string;
  }) => OpencodeClient;
  readonly loadOpenCodeInventory: (
    client: OpencodeClient,
  ) => Effect.Effect<OpenCodeInventory, OpenCodeRuntimeError>;
  readonly loadOpenCodeSkills: (
    client: OpencodeClient,
  ) => Effect.Effect<ReadonlyArray<OpenCodeSkill>, OpenCodeRuntimeError>;
  readonly loadInventoryFromCli: (input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly environment?: NodeJS.ProcessEnv;
  }) => Effect.Effect<OpenCodeInventory, OpenCodeRuntimeError>;
  readonly loadSkillsFromCli: (input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly environment?: NodeJS.ProcessEnv;
  }) => Effect.Effect<ReadonlyArray<OpenCodeSkill>, OpenCodeRuntimeError>;
}

/** Strip generated serve passwords from diagnostics. Never log the raw `server password` line. */
export function redactOpenCodeServerDiagnostics(output: string): string {
  return output.replace(/server password\s+\S+/gi, "server password [redacted]");
}

/** @internal OpenCode 1 prints `opencode server listening on …`. OpenCode 2 prints `server listening on …` plus `server password …`. */
export function parseOpenCodeServerStartup(output: string): {
  readonly url: string | null;
  readonly password: string | null;
} {
  let url: string | null = null;
  let password: string | null = null;
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    const listen = trimmed.match(/^(?:opencode )?server listening on (https?:\/\/[^\s]+)/i);
    if (listen?.[1]) {
      url = listen[1];
    }
    const parsedPassword = trimmed.match(/^server password\s+(\S+)/i);
    if (parsedPassword?.[1]) {
      password = parsedPassword[1];
    }
  }
  return { url, password };
}

const SLUG_LINE_RE = /^(\S+\/\S+)\s*$/;
const AGENT_HEADER_RE = /^(.+)\s+\((\S+)\)\s*$/;

// Agents that are always hidden in OpenCode but the CLI "agent list" command
// does not expose the hidden flag. Keep in sync with OpenCode agent
// definitions (in the OpenCode repo: packages/opencode/src/agent/agent.ts).
const KNOWN_HIDDEN_AGENTS = new Set(["compaction", "summary", "title"]);

/** @internal */
export function parseModelsCliOutput(stdout: string): {
  readonly providers: ReadonlyMap<
    string,
    { readonly id: string; readonly name: string; readonly models: { [key: string]: Model } }
  >;
  readonly connected: ReadonlyArray<string>;
} {
  const providers = new Map<
    string,
    { id: string; name: string; models: { [key: string]: Model } }
  >();
  const lines = stdout.split("\n");
  let currentSlug: string | null = null;
  const jsonLines: Array<string> = [];

  const flushModel = () => {
    if (currentSlug !== null && jsonLines.length > 0) {
      const jsonStr = jsonLines.join("\n").trim();
      if (jsonStr.length > 0) {
        try {
          const model = JSON.parse(jsonStr) as Model;
          const separator = currentSlug.indexOf("/");
          if (separator > 0) {
            const providerID = currentSlug.slice(0, separator);
            const modelID = currentSlug.slice(separator + 1);
            let provider = providers.get(providerID);
            if (!provider) {
              provider = { id: providerID, name: providerID, models: {} };
              providers.set(providerID, provider);
            }
            provider.models[modelID] = model;
          }
        } catch {
          // Skip unparseable model JSON
        }
      }
    }
    currentSlug = null;
    jsonLines.length = 0;
  };

  for (const line of lines) {
    // A model's JSON body is a single `JSON.stringify` line starting with `{`,
    // while a provider/model slug is a bare `provider/model` header. Only the
    // latter can be a slug: without this guard a body line with no interior
    // whitespace and a `/` in one of its values (e.g. an OpenRouter model whose
    // `id` is `vendor/model`) matches SLUG_LINE_RE, so flushModel runs against
    // an empty body and the model is silently dropped.
    const slugMatch = line.trimStart().startsWith("{") ? null : SLUG_LINE_RE.exec(line);
    if (slugMatch) {
      flushModel();
      currentSlug = slugMatch[1]!;
    } else if (currentSlug !== null) {
      jsonLines.push(line);
    }
  }
  flushModel();

  return { providers, connected: [...providers.keys()] };
}

/** @internal */
export function parseAgentListCliOutput(stdout: string): ReadonlyArray<Agent> {
  const agents: Array<Agent> = [];
  const lines = stdout.split("\n");
  let currentHeader: { name: string; mode: string } | null = null;
  const blockLines: Array<string> = [];

  const flushAgent = () => {
    if (currentHeader !== null) {
      const jsonStr = blockLines.join("\n").trim();
      if (jsonStr.length > 0) {
        try {
          const permission = JSON.parse(jsonStr);
          agents.push({
            name: currentHeader.name,
            mode: currentHeader.mode as Agent["mode"],
            hidden: KNOWN_HIDDEN_AGENTS.has(currentHeader.name),
            permission,
            options: {},
          });
        } catch {
          // Skip unparseable agent
        }
      }
    }
    currentHeader = null;
    blockLines.length = 0;
  };

  for (const line of lines) {
    const match = AGENT_HEADER_RE.exec(line);
    if (match) {
      flushAgent();
      currentHeader = { name: match[1]!, mode: match[2]! };
    } else if (currentHeader !== null) {
      blockLines.push(line);
    }
  }
  flushAgent();

  return agents;
}

/** @internal */
export function parseSkillsCliOutput(stdout: string): ReadonlyArray<OpenCodeSkill> {
  const result = decodeOpenCodeSkillsCliOutputExit(stdout);
  return Exit.isSuccess(result) ? result.value : [];
}

export function parseOpenCodeModelSlug(
  slug: string | null | undefined,
): ParsedOpenCodeModelSlug | null {
  if (typeof slug !== "string") {
    return null;
  }

  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }

  return {
    providerID: trimmed.slice(0, separator),
    modelID: trimmed.slice(separator + 1),
  };
}

export function openCodeQuestionId(
  index: number,
  question: QuestionRequest["questions"][number],
): string {
  const header = question.header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return header.length > 0 ? `question-${index}-${header}` : `question-${index}`;
}

/**
 * Attachments OpenCode can hand to a model as a native file part. Anything
 * else (ZIP, binaries, image formats like BMP/AVIF/SVG that model APIs
 * reject, or files over the direct-attachment size limit) would make the turn
 * fail before it starts, so those ride only as the file path ProviderService
 * puts in the prompt.
 */
const OPENCODE_NATIVE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const OPENCODE_NATIVE_FILE_PART_MAX_BYTES = 20 * 1024 * 1024;

function isOpenCodeNativeFilePart(input: {
  readonly mimeType: string;
  readonly sizeBytes: number;
}): boolean {
  if (input.sizeBytes > OPENCODE_NATIVE_FILE_PART_MAX_BYTES) {
    return false;
  }
  const normalized = input.mimeType.trim().toLowerCase();
  return (
    OPENCODE_NATIVE_IMAGE_MIMES.has(normalized) ||
    normalized.startsWith("text/") ||
    normalized === "application/pdf"
  );
}

export function toOpenCodeFileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): Array<FilePartInput> {
  const parts: Array<FilePartInput> = [];

  for (const attachment of input.attachments ?? []) {
    if (
      attachment.type === "file" &&
      "source" in attachment &&
      attachment.source?._tag === "pasted-text"
    ) {
      continue;
    }
    if (!isOpenCodeNativeFilePart(attachment)) {
      continue;
    }
    const attachmentPath = input.resolveAttachmentPath(attachment);
    if (!attachmentPath) {
      continue;
    }

    parts.push({
      type: "file",
      mime: attachment.mimeType,
      filename: attachment.name,
      url: NodeURL.pathToFileURL(attachmentPath).href,
    });
  }

  return parts;
}

export function buildOpenCodePermissionRules(runtimeMode: RuntimeMode): PermissionRuleset {
  if (runtimeMode === "full-access") {
    return [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
    ];
  }

  // "Auto-accept edits" is documented as "auto-approve edits, ask before other
  // actions", so prompting for every edit ignores the mode the user picked.
  // "auto" is left asking on purpose: the docs say providers without an AI
  // reviewer, OpenCode among them, fall back to Supervised for that mode.
  const editAction = runtimeMode === "auto-accept-edits" ? "allow" : "ask";

  // Session rules override OpenCode's agent defaults. Allow reads and task
  // updates, but keep its default approval rules for environment files.
  return [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "read", pattern: "*.env", action: "ask" },
    { permission: "read", pattern: "*.env.*", action: "ask" },
    { permission: "read", pattern: "*.env.example", action: "allow" },
    { permission: "glob", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "lsp", pattern: "*", action: "allow" },
    { permission: "skill", pattern: "*", action: "allow" },
    { permission: "todowrite", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "*", action: editAction },
    { permission: "webfetch", pattern: "*", action: "ask" },
    { permission: "websearch", pattern: "*", action: "ask" },
    { permission: "codesearch", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "ask" },
    { permission: "doom_loop", pattern: "*", action: "ask" },
    { permission: "question", pattern: "*", action: "allow" },
  ];
}

export function toOpenCodePermissionReply(
  decision: ProviderApprovalDecision,
): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
    case "acceptAlways":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

export function toOpenCodeQuestionAnswers(
  request: QuestionRequest,
  answers: Record<string, unknown>,
): Array<QuestionAnswer> {
  return request.questions.map((question, index) => {
    const raw =
      answers[openCodeQuestionId(index, question)] ??
      answers[question.header] ??
      answers[question.question];
    if (Array.isArray(raw)) {
      return raw.filter((value): value is string => typeof value === "string");
    }
    if (typeof raw === "string") {
      return raw.trim().length > 0 ? [raw] : [];
    }
    return [];
  });
}

function ensureRuntimeError(
  operation: OpenCodeRuntimeError["operation"],
  detail: string,
  cause: unknown,
): OpenCodeRuntimeError {
  return OpenCodeRuntimeError.is(cause)
    ? cause
    : new OpenCodeRuntimeError({ operation, detail, cause });
}

const makeOpenCodeRuntime = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const netService = yield* NetService.NetService;
  const hostPlatform = yield* HostProcessPlatform;
  const httpClient = yield* HttpClient.HttpClient;
  const withHttpClient = <A, E, R>(
    effect: Effect.Effect<A, E, R | HttpClient.HttpClient>,
  ): Effect.Effect<A, E, Exclude<R, HttpClient.HttpClient>> =>
    effect.pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
  const resolveCommand = (command: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
    resolveSpawnCommand(command, args, env ? { env } : {});

  const runOpenCodeCommand: OpenCodeRuntimeShape["runOpenCodeCommand"] = (input) =>
    Effect.gen(function* () {
      const spawnCommand = yield* resolveCommand(input.binaryPath, input.args, input.environment);
      const child = yield* spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          detached: hostPlatform !== "win32",
          shell: spawnCommand.shell,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.environment ? { env: input.environment } : { extendEnv: true }),
        }),
      );
      const terminateCommandGroup =
        hostPlatform === "win32"
          ? child.kill({ killSignal: "SIGKILL" }).pipe(Effect.asVoid)
          : Effect.sync(() => {
              try {
                process.kill(-Number(child.pid), "SIGKILL");
              } catch {
                // The command and its process group may already have exited.
              }
            });
      yield* Effect.addFinalizer(() => terminateCommandGroup.pipe(Effect.ignore));
      const collectOptions =
        input.maxOutputBytes === undefined ? undefined : { maxBytes: input.maxOutputBytes };
      const [stdout, stderr, code] = yield* Effect.all(
        [
          collectStreamAsString(child.stdout, collectOptions),
          collectStreamAsString(child.stderr, collectOptions),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      const exitCode = Number(code);
      if (yield* isWindowsCommandNotFound(exitCode, stderr)) {
        return yield* new OpenCodeRuntimeError({
          operation: "runOpenCodeCommand",
          detail: `spawn ${input.binaryPath} ENOENT`,
        });
      }
      return {
        stdout,
        stderr,
        code: exitCode,
      } satisfies OpenCodeCommandResult;
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        ensureRuntimeError(
          "runOpenCodeCommand",
          `Failed to execute '${input.binaryPath} ${input.args.join(" ")}': ${openCodeRuntimeErrorDetail(cause)}`,
          cause,
        ),
      ),
    );

  const createOpenCodeSdkClient: OpenCodeRuntimeShape["createOpenCodeSdkClient"] = (input) =>
    createOpencodeClient({
      baseUrl: input.baseUrl,
      directory: input.directory,
      ...(input.serverPassword &&
      openCodeV2CredentialUrlError(input.baseUrl, input.serverPassword) === undefined
        ? {
            headers: {
              Authorization: `Basic ${Buffer.from(`opencode:${input.serverPassword}`, "utf8").toString("base64")}`,
            },
          }
        : {}),
      throwOnError: true,
    });

  const startOpenCodeServerProcess: OpenCodeRuntimeShape["startOpenCodeServerProcess"] = (input) =>
    Effect.gen(function* () {
      // Bind this server's lifetime to the caller's scope. When the caller's
      // scope closes, the spawned child is killed and all associated fibers
      // are interrupted automatically — no `close()` method needed.
      const runtimeScope = yield* Scope.Scope;

      const hostname = input.hostname ?? DEFAULT_HOSTNAME;
      const port =
        input.port ??
        (yield* netService.findAvailablePort(0).pipe(
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `Failed to find available port: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        ));
      const timeoutMs = input.timeoutMs ?? DEFAULT_OPENCODE_SERVER_TIMEOUT_MS;
      const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];
      const spawnCommand = yield* resolveCommand(input.binaryPath, args, input.environment);
      const serverPassword = resolveOpenCodeServerPassword({
        external: false,
        ...(input.serverPassword !== undefined ? { serverPassword: input.serverPassword } : {}),
        ...(input.environment !== undefined ? { environment: input.environment } : {}),
      });

      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            detached: hostPlatform !== "win32",
            shell: spawnCommand.shell,
            env: {
              ...input.environment,
              ...(serverPassword !== undefined ? { OPENCODE_SERVER_PASSWORD: serverPassword } : {}),
              // Respect an OPENCODE_CONFIG_CONTENT provided by the caller or
              // the inherited process environment, only falling back to the
              // empty config when neither is set. Setting it unconditionally
              // previously clobbered the user's opencode config, hiding their
              // providers/models. The value is set explicitly (rather than
              // relying on inheritance) because `extendEnv` is false whenever
              // `input.environment` is provided.
              OPENCODE_CONFIG_CONTENT: resolveOpenCodeConfigContent(input.environment),
            },
            extendEnv: input.environment === undefined,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, runtimeScope),
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `Failed to spawn OpenCode server process: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        );

      const killOpenCodeProcessGroup = (signal: NodeJS.Signals) =>
        hostPlatform === "win32"
          ? child.kill({ killSignal: signal, forceKillAfter: "1 second" }).pipe(Effect.asVoid)
          : Effect.sync(() => {
              try {
                process.kill(-Number(child.pid), signal);
              } catch {
                // The direct child may already have exited after starting the
                // server; the process group kill is best-effort cleanup for
                // any serve process left in that group.
              }
            });
      const terminateChild = killOpenCodeProcessGroup("SIGTERM").pipe(
        Effect.andThen(Effect.sleep("1 second")),
        Effect.andThen(killOpenCodeProcessGroup("SIGKILL")),
        Effect.ignore,
      );
      yield* Scope.addFinalizer(runtimeScope, terminateChild);

      const stdoutRef = yield* Ref.make<string | null>("");
      const stderrRef = yield* Ref.make<string | null>("");
      const readyDeferred = yield* Deferred.make<string, OpenCodeRuntimeError>();

      const setReadyFromStdoutChunk = (chunk: string) =>
        Ref.modify(stdoutRef, (stdout) => {
          if (stdout === null) {
            return [null, null] as const;
          }
          const nextStdout = `${stdout}${chunk}`;
          const parsed = parseOpenCodeServerStartup(nextStdout);
          const isV1ListenBanner = /opencode server listening on /i.test(nextStdout);
          const readyUrl =
            parsed.url !== null && (isV1ListenBanner || parsed.password !== null)
              ? parsed.url
              : null;
          return [readyUrl, nextStdout.slice(-OPENCODE_SERVER_STARTUP_MAX_OUTPUT_CHARS)] as const;
        }).pipe(
          Effect.flatMap((parsed) =>
            parsed ? Deferred.succeed(readyDeferred, parsed).pipe(Effect.ignore) : Effect.void,
          ),
        );

      const stdoutFiber = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach(setReadyFromStdoutChunk),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );
      const stderrFiber = yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Ref.update(stderrRef, (stderr) =>
            stderr === null
              ? null
              : `${stderr}${chunk}`.slice(-OPENCODE_SERVER_STARTUP_MAX_OUTPUT_CHARS),
          ),
        ),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const exitFiber = yield* child.exitCode.pipe(
        Effect.flatMap((code) =>
          Effect.gen(function* () {
            const stdout = (yield* Ref.get(stdoutRef)) ?? "";
            const stderr = (yield* Ref.get(stderrRef)) ?? "";
            const exitCode = Number(code);
            yield* Deferred.fail(
              readyDeferred,
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: [
                  `OpenCode server exited before startup completed (code: ${String(exitCode)}).`,
                  stdout.trim()
                    ? `stdout:\n${redactOpenCodeServerDiagnostics(stdout.trim())}`
                    : null,
                  stderr.trim()
                    ? `stderr:\n${redactOpenCodeServerDiagnostics(stderr.trim())}`
                    : null,
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                cause: { exitCode },
              }),
            ).pipe(Effect.ignore);
          }),
        ),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const readyExit = yield* Effect.exit(
        Deferred.await(readyDeferred).pipe(Effect.timeoutOption(timeoutMs)),
      );

      if (Exit.isFailure(readyExit) || Option.isNone(readyExit.value)) {
        yield* Fiber.interruptAll([stdoutFiber, stderrFiber, exitFiber]).pipe(Effect.ignore);
      }

      if (Exit.isFailure(readyExit)) {
        const squashed = Cause.squash(readyExit.cause);
        return yield* ensureRuntimeError(
          "startOpenCodeServerProcess",
          `Failed while waiting for OpenCode server startup: ${openCodeRuntimeErrorDetail(squashed)}`,
          squashed,
        );
      }

      const readyOption = readyExit.value;
      if (Option.isNone(readyOption)) {
        return yield* new OpenCodeRuntimeError({
          operation: "startOpenCodeServerProcess",
          detail: `Timed out waiting for OpenCode server start after ${timeoutMs}ms.`,
        });
      }

      const url = readyOption.value;
      const startup = parseOpenCodeServerStartup((yield* Ref.get(stdoutRef)) ?? "");
      const resolvedPassword = startup.password ?? serverPassword;

      // Keep draining both pipes until the process scope closes. Stopping the
      // readers can block OpenCode when its output buffers fill. Startup output
      // is no longer needed, so discard later output instead of retaining it.
      yield* Ref.set(stdoutRef, null);
      yield* Ref.set(stderrRef, null);

      const version = yield* withHttpClient(
        resolveOpenCodeServerVersion(
          createOpenCodeSdkClient({
            baseUrl: url,
            directory: input.directory,
            ...(resolvedPassword !== undefined ? { serverPassword: resolvedPassword } : {}),
          }),
          {
            baseUrl: url,
            ...(resolvedPassword !== undefined ? { serverPassword: resolvedPassword } : {}),
          },
        ),
      );

      return {
        url,
        ...(resolvedPassword !== undefined ? { serverPassword: resolvedPassword } : {}),
        version,
        isRunning: child.isRunning.pipe(Effect.orElseSucceed(() => false)),
        exitCode: child.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => 0),
        ),
      } satisfies OpenCodeServerProcess;
    });

  const connectToOpenCodeServer: OpenCodeRuntimeShape["connectToOpenCodeServer"] = (input) => {
    const serverUrl = input.serverUrl?.trim();
    if (serverUrl) {
      const serverPassword = resolveOpenCodeServerPassword({
        external: true,
        ...(input.serverPassword !== undefined ? { serverPassword: input.serverPassword } : {}),
      });
      return withHttpClient(
        resolveOpenCodeServerVersion(
          createOpenCodeSdkClient({
            baseUrl: serverUrl,
            directory: input.directory,
            ...(serverPassword !== undefined ? { serverPassword } : {}),
          }),
          {
            baseUrl: serverUrl,
            ...(serverPassword !== undefined ? { serverPassword } : {}),
          },
        ),
      ).pipe(
        Effect.map((version) => ({
          url: serverUrl,
          ...(serverPassword !== undefined ? { serverPassword } : {}),
          version,
          exitCode: null,
          external: true,
        })),
      );
    }

    return startOpenCodeServerProcess({
      binaryPath: input.binaryPath,
      directory: input.directory,
      ...(input.serverPassword !== undefined ? { serverPassword: input.serverPassword } : {}),
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    }).pipe(
      Effect.map((server) => ({
        url: server.url,
        ...(server.serverPassword !== undefined ? { serverPassword: server.serverPassword } : {}),
        version: server.version,
        exitCode: server.exitCode,
        external: false,
      })),
    );
  };

  const loadProviders = (client: OpencodeClient) =>
    runOpenCodeSdk("provider.list", (signal) => client.provider.list(undefined, { signal })).pipe(
      Effect.filterMapOrFail(
        (list) =>
          list.data
            ? Result.succeed(list.data)
            : Result.fail(
                new OpenCodeRuntimeError({
                  operation: "provider.list",
                  detail: "OpenCode provider list was empty.",
                }),
              ),
        (result) => result,
      ),
    );

  const loadAgents = (client: OpencodeClient) =>
    runOpenCodeSdk("app.agents", (signal) => client.app.agents(undefined, { signal })).pipe(
      Effect.map((result) => result.data ?? []),
      Effect.orElseSucceed((): ReadonlyArray<Agent> => []),
    );

  const loadOpenCodeSkills: OpenCodeRuntimeShape["loadOpenCodeSkills"] = (client) =>
    runOpenCodeSdk("app.skills", (signal) => client.app.skills(undefined, { signal })).pipe(
      Effect.map((result) =>
        (result.data ?? []).map((skill) => ({
          name: skill.name,
          ...(skill.description === undefined ? {} : { description: skill.description }),
          location: skill.location,
        })),
      ),
    );
  const loadSkills = (client: OpencodeClient) =>
    loadOpenCodeSkills(client).pipe(Effect.orElseSucceed((): ReadonlyArray<OpenCodeSkill> => []));

  const loadOpenCodeInventory: OpenCodeRuntimeShape["loadOpenCodeInventory"] = (client) =>
    Effect.all(
      [
        loadProviders(client),
        loadAgents(client),
        loadSkills(client),
        loadOpenCodeCommands(client).pipe(Effect.orElseSucceed(() => [])),
      ],
      {
        concurrency: "unbounded",
      },
    ).pipe(
      Effect.map(([providerList, agents, skills, commands]) => ({
        providerList,
        agents,
        skills,
        commands,
      })),
    );

  const loadInventoryFromCli: OpenCodeRuntimeShape["loadInventoryFromCli"] = (input) =>
    Effect.gen(function* () {
      const env = input.environment !== undefined ? { environment: input.environment } : ({} as {});
      const commandContext = { cwd: input.cwd, ...env };

      const runModelsCli = () =>
        runOpenCodeCommand({
          binaryPath: input.binaryPath,
          args: ["models", "--verbose"],
          ...commandContext,
        }).pipe(Effect.exit);
      const runAgentsCli = () =>
        runOpenCodeCommand({
          binaryPath: input.binaryPath,
          args: ["agent", "list"],
          ...commandContext,
        }).pipe(Effect.exit);
      const runSkillsCli = () =>
        runOpenCodeCommand({
          binaryPath: input.binaryPath,
          args: ["debug", "skill"],
          maxOutputBytes: OPENCODE_SKILL_DISCOVERY_MAX_OUTPUT_BYTES,
          ...commandContext,
        }).pipe(Effect.exit);

      // Every OpenCode CLI command opens the same shared SQLite database. Running them
      // concurrently causes "database is locked" failures, so run them one at a time.
      const [initialModelsResult, initialAgentsResult, initialSkillsResult] = yield* Effect.all(
        [runModelsCli(), runAgentsCli(), runSkillsCli()],
        { concurrency: 1 },
      );
      let modelsResult = initialModelsResult;
      let agentsResult = initialAgentsResult;
      let skillsResult = initialSkillsResult;

      // Retry once after 1s on transient failures (e.g. SQLite "database is locked")
      const needsModelsRetry = modelsResult._tag === "Failure" || modelsResult.value.code !== 0;
      const needsAgentsRetry = agentsResult._tag === "Failure" || agentsResult.value.code !== 0;
      const needsSkillsRetry = skillsResult._tag === "Failure" || skillsResult.value.code !== 0;
      if (needsModelsRetry || needsAgentsRetry || needsSkillsRetry) {
        yield* Effect.sleep("1 second");
        const [m2, a2, s2] = yield* Effect.all(
          [
            needsModelsRetry ? runModelsCli() : Effect.succeed(modelsResult),
            needsAgentsRetry ? runAgentsCli() : Effect.succeed(agentsResult),
            needsSkillsRetry ? runSkillsCli() : Effect.succeed(skillsResult),
          ],
          { concurrency: 1 },
        );
        modelsResult = m2;
        agentsResult = a2;
        skillsResult = s2;
      }

      if (modelsResult._tag === "Failure") {
        const cause = Cause.squash(modelsResult.cause);
        return yield* ensureRuntimeError(
          "loadInventoryFromCli",
          `Failed to load OpenCode models: ${openCodeRuntimeErrorDetail(cause)}`,
          cause,
        );
      }
      if (modelsResult.value.code !== 0) {
        return yield* new OpenCodeRuntimeError({
          operation: "loadInventoryFromCli",
          detail: `OpenCode models command exited with code ${modelsResult.value.code}.`,
        });
      }

      const parsed = parseModelsCliOutput(modelsResult.value.stdout);
      const connected = [...parsed.connected];
      const allProviders: ProviderListResponse["all"] = [...parsed.providers.values()].map(
        (provider) => ({
          id: provider.id,
          name: provider.name,
          source: "config" as const,
          env: [],
          options: {},
          models: provider.models,
        }),
      );

      // Agent and skill metadata enrich the provider snapshot but are not required
      // for an authoritative model inventory, so either may degrade to an empty list.
      let agents: ReadonlyArray<Agent> = [];
      if (agentsResult._tag === "Success" && agentsResult.value.code === 0) {
        agents = parseAgentListCliOutput(agentsResult.value.stdout);
      }
      let skills: ReadonlyArray<OpenCodeSkill> = [];
      if (skillsResult._tag === "Success" && skillsResult.value.code === 0) {
        skills = parseSkillsCliOutput(skillsResult.value.stdout);
      }

      return {
        providerList: { all: allProviders, default: {}, connected },
        agents,
        skills,
      };
    });

  const loadSkillsFromCli: OpenCodeRuntimeShape["loadSkillsFromCli"] = (input) =>
    runOpenCodeCommand({
      binaryPath: input.binaryPath,
      args: ["debug", "skill"],
      cwd: input.cwd,
      maxOutputBytes: OPENCODE_SKILL_DISCOVERY_MAX_OUTPUT_BYTES,
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
    }).pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.succeed(parseSkillsCliOutput(result.stdout))
          : Effect.fail(
              new OpenCodeRuntimeError({
                operation: "loadSkillsFromCli",
                detail: `OpenCode skills command exited with code ${result.code}.`,
              }),
            ),
      ),
    );

  return {
    startOpenCodeServerProcess,
    connectToOpenCodeServer,
    runOpenCodeCommand,
    createOpenCodeSdkClient,
    loadOpenCodeInventory,
    loadOpenCodeSkills,
    loadInventoryFromCli,
    loadSkillsFromCli,
  } satisfies OpenCodeRuntimeShape;
});

export class OpenCodeRuntime extends Context.Service<OpenCodeRuntime, OpenCodeRuntimeShape>()(
  "t3/provider/opencodeRuntime",
) {}

export const OpenCodeRuntimeLive = Layer.effect(OpenCodeRuntime, makeOpenCodeRuntime).pipe(
  Layer.provide(NetService.layer),
  Layer.provide(FetchHttpClient.layer),
);
