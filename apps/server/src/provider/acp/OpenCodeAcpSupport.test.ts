import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  buildOpenCodeAcpSpawnInput,
  openCodeAcpSpawnArgs,
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
