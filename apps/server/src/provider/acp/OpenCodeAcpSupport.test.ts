import * as NodeAssert from "node:assert/strict";

import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyOpenCodeAcpModelSelection,
  buildOpenCodeAcpSpawnInput,
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
