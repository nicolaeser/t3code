import * as NodeAssert from "node:assert/strict";

import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyOpenCodeAcpModelSelection,
  buildOpenCodeAcpSpawnInput,
  extractOpenCodeElicitationQuestions,
  makeOpenCodeElicitationResponse,
  openCodeAcpSpawnArgs,
  selectOpenCodePermissionOptionId,
  shouldUseOpenCodeAcp,
} from "./OpenCodeAcpSupport.ts";

describe("shouldUseOpenCodeAcp", () => {
  it("uses ACP for a local OpenCode 2 CLI", () => {
    NodeAssert.equal(shouldUseOpenCodeAcp({ serverUrl: "", cliVersion: "2.0.6" }), true);
  });

  it("keeps the HTTP adapter for OpenCode 1 and for an explicit server URL", () => {
    NodeAssert.equal(shouldUseOpenCodeAcp({ serverUrl: "", cliVersion: "1.18.30" }), false);
    NodeAssert.equal(
      shouldUseOpenCodeAcp({ serverUrl: "http://127.0.0.1:4096", cliVersion: "2.0.6" }),
      false,
    );
    NodeAssert.equal(shouldUseOpenCodeAcp({ serverUrl: "", cliVersion: null }), false);
  });
});

describe("openCodeAcpSpawnArgs", () => {
  it("starts the ACP stdio server", () => {
    NodeAssert.deepEqual(openCodeAcpSpawnArgs(), ["acp"]);
    NodeAssert.deepEqual(openCodeAcpSpawnArgs("approval-required"), ["acp"]);
    NodeAssert.deepEqual(openCodeAcpSpawnArgs("full-access"), ["--auto", "acp"]);
  });
});

describe("buildOpenCodeAcpSpawnInput", () => {
  it("uses the configured binary path", () => {
    const spawn = buildOpenCodeAcpSpawnInput(
      { binaryPath: "/opt/opencode" },
      "/workspace",
      { PATH: "/bin" },
      "approval-required",
    );
    NodeAssert.equal(spawn.command, "/opt/opencode");
    NodeAssert.deepEqual(spawn.args, ["acp"]);
    NodeAssert.equal(spawn.cwd, "/workspace");
    NodeAssert.equal(spawn.env?.PATH, "/bin");
  });
});

describe("selectOpenCodePermissionOptionId", () => {
  const request = {
    sessionId: "session",
    toolCall: { toolCallId: "tool", title: "Run", kind: "execute", status: "pending" },
    options: [
      { optionId: "run-this-time", name: "Run this time", kind: "allow_once" },
      { optionId: "always-allow", name: "Always allow", kind: "allow_always" },
      { optionId: "skip-this-time", name: "Skip", kind: "reject_once" },
    ],
  } as EffectAcpSchema.RequestPermissionRequest;

  it("maps decisions to the offered option ids", () => {
    NodeAssert.equal(selectOpenCodePermissionOptionId(request, "accept"), "run-this-time");
    NodeAssert.equal(selectOpenCodePermissionOptionId(request, "acceptForSession"), "always-allow");
    NodeAssert.equal(selectOpenCodePermissionOptionId(request, "decline"), "skip-this-time");
    NodeAssert.equal(selectOpenCodePermissionOptionId(request, "cancel"), undefined);
  });
});

describe("applyOpenCodeAcpModelSelection", () => {
  effectIt.effect("applies model, variant, and agent config options", () =>
    Effect.gen(function* () {
      const setCalls: Array<[string, string | boolean]> = [];
      const runtime = {
        getConfigOptions: Effect.succeed([
          { type: "select", id: "model", name: "Model", currentValue: "", options: [] },
          { type: "select", id: "variant", name: "Reasoning", currentValue: "", options: [] },
          { type: "select", id: "agent", name: "Agent", currentValue: "", options: [] },
        ] as ReadonlyArray<EffectAcpSchema.SessionConfigOption>),
        setConfigOption: (id: string, value: string | boolean) =>
          Effect.sync(() => {
            setCalls.push([id, value]);
          }),
        setModel: () => Effect.die("setModel should not run when a model config option exists"),
      };

      yield* applyOpenCodeAcpModelSelection({
        runtime,
        model: "xai/grok-4.6",
        options: [
          { id: "variant", value: "high" },
          { id: "agent", value: "plan" },
        ],
        mapError: (cause) => cause.message,
      });

      NodeAssert.deepEqual(setCalls, [
        ["model", "xai/grok-4.6"],
        ["variant", "high"],
        ["agent", "plan"],
      ]);
    }),
  );
});

describe("OpenCode ACP elicitation", () => {
  it("maps form fields to questions and accepted answers to content", () => {
    const request = {
      mode: "form",
      sessionId: "session",
      message: "Need a project name",
      requestedSchema: {
        title: "Project",
        properties: {
          name: { type: "string", title: "Name" },
          kind: { type: "string", title: "Kind", enum: ["app", "lib"] },
        },
      },
    } as EffectAcpSchema.ElicitationRequest;

    const questions = extractOpenCodeElicitationQuestions(request);
    NodeAssert.equal(questions[0]?.id, "name");
    NodeAssert.equal(questions[0]?.allowCustomAnswer, true);
    NodeAssert.equal(questions[1]?.id, "kind");
    NodeAssert.deepEqual(
      questions[1]?.options.map((option) => option.value),
      ["app", "lib"],
    );
    NodeAssert.deepEqual(makeOpenCodeElicitationResponse(request, { name: "t3", kind: "app" }), {
      action: { action: "accept", content: { name: "t3", kind: "app" } },
    });
    NodeAssert.deepEqual(makeOpenCodeElicitationResponse(request, { name: "true" }), {
      action: { action: "accept", content: { name: "true" } },
    });
    NodeAssert.deepEqual(makeOpenCodeElicitationResponse(request, {}), {
      action: { action: "cancel" },
    });
  });

  it("parses numeric and boolean fields according to the schema", () => {
    const request = {
      mode: "form",
      sessionId: "session",
      message: "Config",
      requestedSchema: {
        properties: {
          count: { type: "integer", title: "Count" },
          ratio: { type: "number", title: "Ratio" },
          enabled: { type: "boolean", title: "Enabled" },
        },
      },
    } as EffectAcpSchema.ElicitationRequest;

    NodeAssert.deepEqual(
      makeOpenCodeElicitationResponse(request, {
        count: "3",
        ratio: "1.5",
        enabled: "true",
      }),
      {
        action: {
          action: "accept",
          content: { count: 3, ratio: 1.5, enabled: true },
        },
      },
    );
  });

  it("maps array schemas to multi-select questions", () => {
    const request = {
      mode: "form",
      sessionId: "session",
      message: "Pick tags",
      requestedSchema: {
        properties: {
          tags: {
            type: "array",
            title: "Tags",
            items: { type: "string", enum: ["cli", "tui"] },
          },
          roles: {
            type: "array",
            title: "Roles",
            items: {
              anyOf: [
                { const: "build", title: "Build" },
                { const: "plan", title: "Plan" },
              ],
            },
          },
        },
      },
    } as EffectAcpSchema.ElicitationRequest;

    const questions = extractOpenCodeElicitationQuestions(request);
    NodeAssert.equal(questions[0]?.multiSelect, true);
    NodeAssert.deepEqual(
      questions[0]?.options.map((option) => option.value),
      ["cli", "tui"],
    );
    NodeAssert.equal(questions[1]?.multiSelect, true);
    NodeAssert.deepEqual(
      questions[1]?.options.map((option) => option.value),
      ["build", "plan"],
    );
    NodeAssert.deepEqual(
      makeOpenCodeElicitationResponse(request, { tags: ["cli", "tui"], roles: ["plan"] }),
      {
        action: {
          action: "accept",
          content: { tags: ["cli", "tui"], roles: ["plan"] },
        },
      },
    );
  });

  it("maps url elicitation to continue/cancel", () => {
    const request = {
      mode: "url",
      sessionId: "session",
      elicitationId: "elicit-1",
      url: "https://example.com/login",
      message: "Sign in",
    } as EffectAcpSchema.ElicitationRequest;

    NodeAssert.equal(extractOpenCodeElicitationQuestions(request)[0]?.id, "continue");
    NodeAssert.deepEqual(makeOpenCodeElicitationResponse(request, { continue: "accept" }), {
      action: { action: "accept" },
    });
    NodeAssert.deepEqual(makeOpenCodeElicitationResponse(request, {}), {
      action: { action: "cancel" },
    });
  });
});
