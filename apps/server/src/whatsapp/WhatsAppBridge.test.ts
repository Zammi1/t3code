// @effect-diagnostics nodeBuiltinImport:off - the fake bridge is a real subprocess with files on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterAll, beforeAll, describe } from "vite-plus/test";

import * as WhatsAppBridge from "./WhatsAppBridge.ts";

const FAKE_BRIDGE = NodeURL.fileURLToPath(new URL("./fixtures/fakeWaMcp.mjs", import.meta.url));

interface ToolAnswer {
  readonly text: string;
  readonly isError?: boolean;
}

interface LoggedCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly nested: string | null;
  readonly source: string | null;
  readonly inheritedSecret: string | null;
}

/** Writes a bridge entry script that runs the fake with these canned answers. */
const fakeBridge = (
  tools: Partial<Record<string, ToolAnswer>>,
  options: { readonly delayMs?: number } = {},
) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-wa-bridge-"));
  const log = NodePath.join(dir, "calls.jsonl");
  const script = NodePath.join(dir, "mcp.mjs");
  NodeFS.writeFileSync(
    script,
    `import { run } from ${JSON.stringify(FAKE_BRIDGE)};\nawait run(${JSON.stringify({ log, tools, ...options })});\n`,
  );
  const calls = (): ReadonlyArray<LoggedCall> =>
    NodeFS.existsSync(log)
      ? NodeFS.readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as LoggedCall)
      : [];
  return { script, calls };
};

const withBridge = <A, E>(
  options: WhatsAppBridge.WhatsAppBridgeOptions,
  use: (bridge: WhatsAppBridge.WhatsAppBridge["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* use(yield* WhatsAppBridge.WhatsAppBridge);
  }).pipe(Effect.provide(WhatsAppBridge.layerWith(options)));

const STATUS_JSON = JSON.stringify({
  away: { on: false },
  link: { state: "linked", number: "447700900000", at: 1_759_990_000 },
  instructions: "I'm fully booked until November",
  pending: [
    { id: 4, kind: "message", chat: "1@s.whatsapp.net", text: "private draft", to: "Kate" },
  ],
  autoRepliesLast24h: 0,
});
const CHATS_TEXT = [
  "2026-10-16 09:30  Kate [brief]  447700900001@s.whatsapp.net",
  "2026-10-15 18:02  Shoot crew (group)  120363000000000001@g.us",
].join("\n");
const TRANSCRIPT_TEXT = [
  "Chat: Kate (447700900001@s.whatsapp.net)",
  "[2026-10-16 09:00] Kate: Hi, are you free Thursday?",
].join("\n");
const KATE = "447700900001@s.whatsapp.net";
const MUTATING_TOOLS = [
  "send_message",
  "send_file",
  "set_away",
  "set_person",
  "set_instructions",
  "set_outcome",
  "ask_assistant",
];

// The adapter spawns the bridge with the SDK's minimal environment; this
// marker proves the server's own environment is not passed through.
beforeAll(() => {
  process.env.T3_FAKE_SECRET = "server-only";
});
afterAll(() => {
  delete process.env.T3_FAKE_SECRET;
});

describe("WhatsAppBridge", () => {
  it.live("reports not configured without starting anything", () =>
    withBridge({ mcpScriptPath: null }, (bridge) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* bridge.getStatus, { _tag: "NotConfigured" });
        const error = yield* Effect.flip(bridge.listChats({ limit: 10 }));
        assert.strictEqual(error.reason, "notConfigured");
      }),
    ),
  );

  it.live("reads the real status shape and drops private fields", () => {
    const fake = fakeBridge({ status: { text: STATUS_JSON } });
    return withBridge({ mcpScriptPath: fake.script }, (bridge) =>
      Effect.gen(function* () {
        const status = yield* bridge.getStatus;
        assert.strictEqual(status._tag, "Available");
        if (status._tag !== "Available") return;
        assert.strictEqual(status.link, "linked");
        assert.strictEqual(status.pendingProposals, 1);
        const serialized = JSON.stringify(status);
        for (const secret of ["447700900000", "booked", "private draft", "Kate"]) {
          assert.notInclude(serialized, secret);
        }
        assert.deepStrictEqual(fake.calls(), [
          { name: "status", args: {}, nested: "1", source: "t3-comms", inheritedSecret: null },
        ]);
      }),
    );
  });

  it.live("turns a missing, failing, or garbled bridge into Unavailable", () =>
    Effect.gen(function* () {
      const missing = yield* withBridge(
        {
          mcpScriptPath: NodePath.join(NodeOS.tmpdir(), "t3-wa-missing", "mcp.mjs"),
          timeout: "5 seconds",
        },
        (bridge) => bridge.getStatus,
      );
      assert.strictEqual(missing._tag, "Unavailable");

      const failing = fakeBridge({ status: { text: "database is locked", isError: true } });
      const refused = yield* withBridge({ mcpScriptPath: failing.script }, (b) => b.getStatus);
      assert.deepInclude(refused, { _tag: "Unavailable", detail: "database is locked" });

      const garbled = fakeBridge({ status: { text: "not json" } });
      const odd = yield* withBridge({ mcpScriptPath: garbled.script }, (b) => b.getStatus);
      assert.strictEqual(odd._tag, "Unavailable");

      const slow = fakeBridge({ status: { text: STATUS_JSON } }, { delayMs: 5_000 });
      const timedOut = yield* withBridge(
        { mcpScriptPath: slow.script, timeout: "300 millis" },
        (b) => b.getStatus,
      );
      assert.deepInclude(timedOut, {
        _tag: "Unavailable",
        detail: "The WhatsApp bridge timed out.",
      });
    }),
  );

  it.live("loading status, chats, and a chat calls only read tools", () => {
    const fake = fakeBridge({
      status: { text: STATUS_JSON },
      list_chats: { text: CHATS_TEXT },
      read_chat: { text: TRANSCRIPT_TEXT },
    });
    return withBridge({ mcpScriptPath: fake.script }, (bridge) =>
      Effect.gen(function* () {
        yield* bridge.getStatus;
        const list = yield* bridge.listChats({ limit: 500 });
        assert.deepStrictEqual(
          list.chats.map((chat) => [chat.name, chat.isGroup]),
          [
            ["Kate", false],
            ["Shoot crew", true],
          ],
        );
        const chat = yield* bridge.readChat({ jid: KATE, limit: 40 });
        assert.strictEqual(chat.messages[0]?.text, "Hi, are you free Thursday?");

        const calls = fake.calls();
        assert.deepStrictEqual(
          calls.map((call) => call.name),
          ["status", "list_chats", "read_chat"],
        );
        assert.deepStrictEqual(calls[1]?.args, { limit: 100, include_groups: true });
        assert.deepStrictEqual(calls[2]?.args, { chat: KATE, limit: 40 });
        for (const call of calls) assert.notInclude(MUTATING_TOOLS, call.name);
      }),
    );
  });

  it.live("refuses names instead of jids and surfaces bridge refusals", () => {
    const fake = fakeBridge({ read_chat: { text: "No chat 9@s.whatsapp.net", isError: true } });
    return withBridge({ mcpScriptPath: fake.script }, (bridge) =>
      Effect.gen(function* () {
        const byName = yield* Effect.flip(bridge.readChat({ jid: "Kate", limit: 10 }));
        assert.strictEqual(byName.reason, "invalidInput");
        assert.deepStrictEqual(fake.calls(), []);

        const refused = yield* Effect.flip(bridge.readChat({ jid: "9@s.whatsapp.net", limit: 10 }));
        assert.deepInclude(refused, { reason: "rejected", detail: "No chat 9@s.whatsapp.net" });
      }),
    );
  });

  it.live("proposes once for a direct chat and returns the proposal id", () => {
    const fake = fakeBridge({
      send_message: {
        text: 'Proposal #42 to Kate +447700900001 queued. Sammy must reply "yes 42" on WhatsApp to send it.',
      },
    });
    return withBridge({ mcpScriptPath: fake.script }, (bridge) =>
      Effect.gen(function* () {
        const group = yield* Effect.flip(
          bridge.proposeMessage({ jid: "120363000000000001@g.us", text: "hi all" }),
        );
        assert.strictEqual(group.reason, "invalidInput");
        const empty = yield* Effect.flip(bridge.proposeMessage({ jid: KATE, text: "   " }));
        assert.strictEqual(empty.reason, "invalidInput");
        assert.deepStrictEqual(fake.calls(), []);

        const proposal = yield* bridge.proposeMessage({ jid: KATE, text: "  See you Thursday " });
        assert.strictEqual(proposal.proposalId, 42);
        assert.include(proposal.detail, 'Reply "yes 42"');
        assert.deepStrictEqual(
          fake.calls().map((call) => [call.name, call.args]),
          [["send_message", { chat: KATE, text: "See you Thursday" }]],
        );
      }),
    );
  });

  it.live("never retries a proposal and refuses a concurrent duplicate", () => {
    const fake = fakeBridge(
      { send_message: { text: "Proposal #7 to Kate queued." } },
      { delayMs: 4_000 },
    );
    return withBridge({ mcpScriptPath: fake.script, timeout: "2 seconds" }, (bridge) =>
      Effect.gen(function* () {
        const [first, second] = yield* Effect.all(
          [
            Effect.flip(bridge.proposeMessage({ jid: KATE, text: "Running late" })),
            Effect.flip(bridge.proposeMessage({ jid: KATE, text: "Running late" })),
          ],
          { concurrency: 2 },
        );
        const reasons = [first.reason, second.reason].toSorted();
        assert.deepStrictEqual(reasons, ["invalidInput", "unavailable"]);
        const timedOut = first.reason === "unavailable" ? first : second;
        assert.include(timedOut.detail, "outcome is unknown");
        // A retry would have run before the failure returned.
        assert.deepStrictEqual(
          fake.calls().map((call) => call.name),
          ["send_message"],
        );
      }),
    );
  });
});
