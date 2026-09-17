import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  isOpenCodeV2CliVersion,
  openCodeInventoryFromV2Rest,
  openCodeV2CredentialUrlError,
  parseAgentListCliOutput,
  parseModelsCliOutput,
  parseOpenCodeServerStartup,
  parseSkillsCliOutput,
  redactOpenCodeServerDiagnostics,
  toOpenCodeFileParts,
} from "./opencodeRuntime.ts";

describe("parseModelsCliOutput", () => {
  it("parses a single model from a single provider", () => {
    const stdout = [
      "anthropic/claude-sonnet-4-5",
      JSON.stringify({
        id: "claude-sonnet-4-5",
        providerID: "anthropic",
        name: "Claude Sonnet 4.5",
        capabilities: { temperature: true, reasoning: true, toolcall: true },
        cost: { input: 3, output: 15 },
        limit: { context: 200000, output: 8192 },
        status: "active",
        options: {},
        headers: {},
        release_date: "2025-01-01",
      }),
    ].join("\n");

    const result = parseModelsCliOutput(stdout);
    NodeAssert.equal(result.providers.size, 1);
    NodeAssert.equal(result.connected.length, 1);
    NodeAssert.equal(result.connected[0], "anthropic");

    const provider = result.providers.get("anthropic")!;
    NodeAssert.ok(provider);
    NodeAssert.equal(provider.id, "anthropic");
    NodeAssert.equal(provider.name, "anthropic");
    NodeAssert.equal(Object.keys(provider.models).length, 1);

    const model = provider.models["claude-sonnet-4-5"]!;
    NodeAssert.ok(model);
    NodeAssert.equal(model.id, "claude-sonnet-4-5");
    NodeAssert.equal(model.providerID, "anthropic");
    NodeAssert.equal(model.name, "Claude Sonnet 4.5");
  });

  it("parses multiple models from multiple providers", () => {
    const stdout = [
      "anthropic/claude-sonnet-4-5",
      JSON.stringify({ id: "claude-sonnet-4-5", providerID: "anthropic", name: "Sonnet 4.5" }),
      "anthropic/claude-haiku-4-5",
      JSON.stringify({ id: "claude-haiku-4-5", providerID: "anthropic", name: "Haiku 4.5" }),
      "openai/gpt-4o",
      JSON.stringify({ id: "gpt-4o", providerID: "openai", name: "GPT-4o" }),
    ].join("\n");

    const result = parseModelsCliOutput(stdout);
    NodeAssert.equal(result.providers.size, 2);
    NodeAssert.equal(result.connected.length, 2);
    NodeAssert.equal([...result.connected].sort().join(","), "anthropic,openai");
    NodeAssert.equal(Object.keys(result.providers.get("anthropic")!.models).length, 2);
    NodeAssert.equal(Object.keys(result.providers.get("openai")!.models).length, 1);
  });

  it("handles empty input", () => {
    const result = parseModelsCliOutput("");
    NodeAssert.equal(result.providers.size, 0);
    NodeAssert.equal(result.connected.length, 0);
  });

  it("skips unparseable JSON blocks", () => {
    const stdout = [
      "anthropic/claude-sonnet-4-5",
      "this is not valid json {{{",
      "anthropic/claude-haiku-4-5",
      JSON.stringify({ id: "claude-haiku-4-5", providerID: "anthropic", name: "Haiku 4.5" }),
    ].join("\n");

    const result = parseModelsCliOutput(stdout);
    NodeAssert.equal(result.providers.size, 1);
    const provider = result.providers.get("anthropic")!;
    NodeAssert.equal(Object.keys(provider.models).length, 1);
    NodeAssert.ok(provider.models["claude-haiku-4-5"]);
  });

  it("handles Windows-style CRLF line endings", () => {
    const stdout =
      "anthropic/claude-sonnet-4-5\r\n" +
      JSON.stringify({ id: "claude-sonnet-4-5", providerID: "anthropic", name: "Sonnet" }) +
      "\r\n";

    const result = parseModelsCliOutput(stdout);
    NodeAssert.equal(result.providers.size, 1);
    NodeAssert.ok(result.providers.get("anthropic")!.models["claude-sonnet-4-5"]);
  });

  it("handles model JSON with variants and nested fields", () => {
    const stdout = [
      "opencode/gpt-5.4",
      JSON.stringify({
        id: "gpt-5.4",
        providerID: "opencode",
        name: "GPT-5.4",
        family: "gpt",
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: false,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 200000, input: 160000, output: 32000 },
        status: "active",
        options: {},
        headers: {},
        release_date: "2025-01-01",
        variants: { none: {}, low: {}, medium: {}, high: {} },
      }),
    ].join("\n");

    const result = parseModelsCliOutput(stdout);
    const model = result.providers.get("opencode")!.models["gpt-5.4"]!;
    NodeAssert.ok(model);
    NodeAssert.ok(model.capabilities);
    NodeAssert.equal(model.capabilities!.reasoning, true);
    NodeAssert.ok(model.variants);
    NodeAssert.equal(model.variants!["medium"] !== undefined, true);
  });

  it("keeps a model whose JSON body has a slash and no interior whitespace", () => {
    // OpenRouter-style: the model id contains a `/` and no string value has a
    // space, so the JSON body line itself matches the slug regex. It must still
    // be treated as the body of the preceding slug, not a new slug.
    const stdout = [
      "openrouter/qwen/qwen3-coder",
      JSON.stringify({
        id: "qwen/qwen3-coder",
        providerID: "openrouter",
        name: "qwen3-coder",
        status: "active",
      }),
    ].join("\n");

    const result = parseModelsCliOutput(stdout);
    NodeAssert.equal(result.providers.size, 1);
    NodeAssert.deepEqual([...result.connected], ["openrouter"]);
    const provider = result.providers.get("openrouter")!;
    NodeAssert.ok(provider);
    const model = provider.models["qwen/qwen3-coder"]!;
    NodeAssert.ok(model);
    NodeAssert.equal(model.id, "qwen/qwen3-coder");
    NodeAssert.equal(model.providerID, "openrouter");
  });
});

describe("parseAgentListCliOutput", () => {
  it("parses a single agent", () => {
    const stdout = [
      "build (primary)",
      "  " + JSON.stringify([{ permission: "*", action: "allow", pattern: "*" }]),
    ].join("\n");

    const result = parseAgentListCliOutput(stdout);
    NodeAssert.equal(result.length, 1);
    NodeAssert.equal(result[0]!.name, "build");
    NodeAssert.equal(result[0]!.mode, "primary");
    NodeAssert.equal(result[0]!.permission.length, 1);
  });

  it("parses multiple agents", () => {
    const stdout = [
      "build (primary)",
      "  " + JSON.stringify([{ permission: "*", action: "allow", pattern: "*" }]),
      "explore (subagent)",
      "  " + JSON.stringify([{ permission: "read", action: "allow", pattern: "*" }]),
      "plan (primary)",
      "  " + JSON.stringify([{ permission: "edit", action: "ask", pattern: "*.md" }]),
    ].join("\n");

    const result = parseAgentListCliOutput(stdout);
    NodeAssert.equal(result.length, 3);
    NodeAssert.equal(result[0]!.name, "build");
    NodeAssert.equal(result[0]!.mode, "primary");
    NodeAssert.equal(result[1]!.name, "explore");
    NodeAssert.equal(result[1]!.mode, "subagent");
    NodeAssert.equal(result[2]!.name, "plan");
    NodeAssert.equal(result[2]!.mode, "primary");
  });

  it("handles empty input", () => {
    const result = parseAgentListCliOutput("");
    NodeAssert.equal(result.length, 0);
  });

  it("skips agents with unparseable permission JSON", () => {
    const stdout = [
      "build (primary)",
      "  not valid json {",
      "explore (subagent)",
      "  " + JSON.stringify([{ permission: "read", action: "allow", pattern: "*" }]),
    ].join("\n");

    const result = parseAgentListCliOutput(stdout);
    NodeAssert.equal(result.length, 1);
    NodeAssert.equal(result[0]!.name, "explore");
  });

  it("handles real-world permission blocks with nested paths", () => {
    const permissions = [
      { permission: "*", action: "allow", pattern: "*" },
      {
        permission: "external_directory",
        pattern: "C:\\Users\\test\\.local\\*",
        action: "allow",
      },
      { permission: "read", pattern: "*.env", action: "ask" },
    ];
    const stdout = ["build (primary)", "  " + JSON.stringify(permissions)].join("\n");

    const result = parseAgentListCliOutput(stdout);
    NodeAssert.equal(result.length, 1);
    NodeAssert.equal(result[0]!.permission.length, 3);
    NodeAssert.equal(result[0]!.permission[0]!.action, "allow");
    NodeAssert.equal(result[0]!.permission[2]!.action, "ask");
  });

  it("handles agent names with spaces", () => {
    const stdout = [
      "code reviewer (subagent)",
      "  " + JSON.stringify([{ permission: "read", action: "allow", pattern: "*" }]),
      "my custom agent (primary)",
      "  " + JSON.stringify([{ permission: "edit", action: "ask", pattern: "*.ts" }]),
    ].join("\n");

    const result = parseAgentListCliOutput(stdout);
    NodeAssert.equal(result.length, 2);
    NodeAssert.equal(result[0]!.name, "code reviewer");
    NodeAssert.equal(result[0]!.mode, "subagent");
    NodeAssert.equal(result[1]!.name, "my custom agent");
    NodeAssert.equal(result[1]!.mode, "primary");
  });

  it("marks known hidden agents", () => {
    const stdout = [
      "compaction (primary)",
      "  " + JSON.stringify([{ permission: "*", action: "allow", pattern: "*" }]),
      "build (primary)",
      "  " + JSON.stringify([{ permission: "*", action: "allow", pattern: "*" }]),
    ].join("\n");

    const result = parseAgentListCliOutput(stdout);
    NodeAssert.equal(result[0]!.hidden, true);
    NodeAssert.equal(result[1]!.hidden, false);
  });
});

describe("parseSkillsCliOutput", () => {
  it("parses only skill metadata from the CLI JSON output", () => {
    const result = parseSkillsCliOutput(
      JSON.stringify([
        {
          name: "review-pr",
          description: "Review a pull request.",
          location: "/tmp/review-pr/SKILL.md",
          content: "---\nname: review-pr\n---\n",
        },
      ]),
    );

    NodeAssert.deepEqual(result, [
      {
        name: "review-pr",
        description: "Review a pull request.",
        location: "/tmp/review-pr/SKILL.md",
      },
    ]);
  });

  it("degrades malformed output to an empty skill list", () => {
    NodeAssert.deepEqual(parseSkillsCliOutput("not json"), []);
  });
});

describe("toOpenCodeFileParts", () => {
  const attachment = (mimeType: string, sizeBytes = 12) => ({
    type: "file" as const,
    id: "thread-1-00000000-0000-4000-8000-000000000001-bin",
    name: "attachment",
    mimeType,
    sizeBytes,
  });

  it("sends supported images, text, and PDFs natively and skips what models reject", () => {
    const parts = toOpenCodeFileParts({
      attachments: [
        attachment("application/pdf"),
        attachment("text/markdown"),
        attachment("image/png"),
        // A ZIP file part makes OpenCode's Anthropic path throw before the
        // turn starts; it must ride only as the prompt's file path line.
        attachment("application/zip"),
        attachment("application/octet-stream"),
        // Image formats the model APIs reject stay on the fallback path too.
        attachment("image/bmp"),
        attachment("image/svg+xml"),
        // Over the direct-attachment limit: path fallback even for a PDF.
        attachment("application/pdf", 21 * 1024 * 1024),
      ],
      resolveAttachmentPath: () => "/tmp/attachment",
    });

    NodeAssert.deepEqual(
      parts.map((part) => part.mime),
      ["application/pdf", "text/markdown", "image/png"],
    );
  });

  it("keeps folded clipboard text on the lazy path fallback", () => {
    const parts = toOpenCodeFileParts({
      attachments: [
        {
          ...attachment("text/plain"),
          source: { _tag: "pasted-text" as const },
        },
      ],
      resolveAttachmentPath: () => "/tmp/pasted-text.txt",
    });

    NodeAssert.deepEqual(parts, []);
  });
});

describe("parseOpenCodeServerStartup", () => {
  it("parses the OpenCode 1 listen banner", () => {
    const parsed = parseOpenCodeServerStartup(
      "opencode server listening on http://127.0.0.1:4096\n",
    );
    NodeAssert.equal(parsed.url, "http://127.0.0.1:4096");
    NodeAssert.equal(parsed.password, null);
  });

  it("parses the OpenCode 2 listen banner and generated password", () => {
    const parsed = parseOpenCodeServerStartup(
      ["server listening on http://127.0.0.1:49152", "server password abc_DEF-123", ""].join("\n"),
    );
    NodeAssert.equal(parsed.url, "http://127.0.0.1:49152");
    NodeAssert.equal(parsed.password, "abc_DEF-123");
  });
});

describe("redactOpenCodeServerDiagnostics", () => {
  it("redacts generated serve passwords from startup output", () => {
    NodeAssert.equal(
      redactOpenCodeServerDiagnostics(
        ["server listening on http://127.0.0.1:49152", "server password abc_DEF-123", ""].join(
          "\n",
        ),
      ),
      ["server listening on http://127.0.0.1:49152", "server password [redacted]", ""].join("\n"),
    );
  });
});

describe("isOpenCodeV2CliVersion", () => {
  it("treats 2.0.0 and newer as OpenCode 2", () => {
    NodeAssert.equal(isOpenCodeV2CliVersion("1.18.30"), false);
    NodeAssert.equal(isOpenCodeV2CliVersion("2.0.0"), true);
    NodeAssert.equal(isOpenCodeV2CliVersion("2.0.6"), true);
    NodeAssert.equal(isOpenCodeV2CliVersion("not-a-version"), false);
    NodeAssert.equal(isOpenCodeV2CliVersion(""), false);
  });
});

describe("openCodeV2CredentialUrlError", () => {
  it("allows loopback HTTP and HTTPS, and rejects other HTTP with a password", () => {
    NodeAssert.equal(openCodeV2CredentialUrlError("http://127.0.0.1:4096", "secret"), undefined);
    NodeAssert.equal(openCodeV2CredentialUrlError("https://opencode.example", "secret"), undefined);
    NodeAssert.equal(openCodeV2CredentialUrlError("http://example.com", undefined), undefined);
    NodeAssert.match(
      openCodeV2CredentialUrlError("http://example.com", "secret") ?? "",
      /HTTPS or loopback HTTP/,
    );
  });
});

describe("openCodeInventoryFromV2Rest", () => {
  it("groups models under connected providers and maps skill paths", () => {
    const inventory = openCodeInventoryFromV2Rest({
      providers: [{ id: "xai", name: "xAI", activation: "enabled" }],
      models: [
        {
          id: "grok-4.6",
          modelID: "grok-4.6",
          providerID: "xai",
          name: "Grok 4.6 Fast",
          variants: ["low", "high"],
        },
      ],
      agents: [{ id: "build", name: "Build", mode: "primary", hidden: false }],
      skills: [{ name: "OpenCode", path: "/builtin/opencode.md", description: "docs" }],
      commands: [
        {
          name: "init",
          description: "guided AGENTS.md setup",
          source: "command",
          hints: ["$ARGUMENTS"],
        },
        { name: "review", source: "skill", hints: [] },
      ],
    });

    NodeAssert.deepEqual(inventory.providerList.connected, ["xai"]);
    NodeAssert.equal(inventory.providerList.all[0]?.models["grok-4.6"]?.name, "Grok 4.6 Fast");
    NodeAssert.equal(inventory.agents[0]?.name, "build");
    NodeAssert.equal(inventory.skills[0]?.location, "/builtin/opencode.md");
    NodeAssert.equal(inventory.commands?.[0]?.name, "init");
    NodeAssert.deepEqual(inventory.commands?.[0]?.hints, ["$ARGUMENTS"]);
    NodeAssert.equal(inventory.commands?.[0]?.source, "command");
    NodeAssert.equal(inventory.commands?.[1]?.source, "skill");
  });

  it("does not treat disabled providers as connected", () => {
    const inventory = openCodeInventoryFromV2Rest({
      providers: [
        { id: "xai", name: "xAI", activation: "disabled" },
        { id: "openai", name: "OpenAI", activation: "disabled" },
      ],
      models: [],
      agents: [],
      skills: [],
      commands: [],
    });

    NodeAssert.deepEqual(inventory.providerList.connected, []);
    NodeAssert.equal(inventory.providerList.all.length, 2);
  });
});
