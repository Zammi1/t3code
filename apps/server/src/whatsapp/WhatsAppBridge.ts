/**
 * Server-side adapter to a host-local wa-agent WhatsApp bridge.
 *
 * The bridge's documented integration point for T3 Code is its `wa` MCP stdio
 * server. Each request spawns it with this server's Node, calls one tool, and
 * closes it, so nothing stays running and no credentials or bridge paths reach
 * a client. Only four tools are ever called: status, list_chats, read_chat and
 * send_message. send_message only queues a proposal that the owner must
 * confirm with "yes <id>" on WhatsApp; this adapter never sends, never retries
 * a proposal, and never changes away mode, people, or standing instructions.
 *
 * Configure with T3CODE_WHATSAPP_MCP, the absolute path to wa-agent's
 * `src/mcp.mjs`. Unset means the Comms hub reports "not configured".
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import {
  isChatJid,
  isDirectChatJid,
  parseBridgeStatus,
  parseChatList,
  parseChatTranscript,
  parseProposalId,
  type WhatsAppBridgeStatus,
  type WhatsAppChatSummary,
  type WhatsAppChatTranscript,
} from "./whatsAppBridgeFormat.ts";

export type {
  WhatsAppBridgeStatus,
  WhatsAppChatMessage,
  WhatsAppChatSummary,
  WhatsAppChatTranscript,
  WhatsAppLinkState,
} from "./whatsAppBridgeFormat.ts";

export const WHATSAPP_MCP_ENV = "T3CODE_WHATSAPP_MCP";

/** The only bridge tools this adapter may call. Anything else is refused locally. */
export const WHATSAPP_ALLOWED_TOOLS = [
  "status",
  "list_chats",
  "read_chat",
  "send_message",
] as const;
export type WhatsAppAllowedTool = (typeof WHATSAPP_ALLOWED_TOOLS)[number];

export class WhatsAppBridgeError extends Schema.TaggedError<WhatsAppBridgeError>()(
  "WhatsAppBridgeError",
  {
    reason: Schema.Literals(["notConfigured", "unavailable", "rejected", "invalidInput"]),
    /** Short, user-facing description. */
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export type WhatsAppStatus =
  | { readonly _tag: "NotConfigured" }
  | { readonly _tag: "Unavailable"; readonly detail: string; readonly checkedAt: string }
  | ({ readonly _tag: "Available"; readonly checkedAt: string } & WhatsAppBridgeStatus);

export interface WhatsAppChatList {
  readonly chats: ReadonlyArray<WhatsAppChatSummary>;
  readonly checkedAt: string;
}

export interface WhatsAppChatRead extends WhatsAppChatTranscript {
  readonly checkedAt: string;
}

export interface WhatsAppProposal {
  /** Null when the bridge confirmed but its wording changed; the detail still says what to do. */
  readonly proposalId: number | null;
  readonly detail: string;
}

export class WhatsAppBridge extends Context.Service<
  WhatsAppBridge,
  {
    /** Never fails: an unconfigured or broken bridge is a status, not an error. */
    readonly getStatus: Effect.Effect<WhatsAppStatus>;
    readonly listChats: (input: {
      readonly limit: number;
    }) => Effect.Effect<WhatsAppChatList, WhatsAppBridgeError>;
    readonly readChat: (input: {
      readonly jid: string;
      readonly limit: number;
    }) => Effect.Effect<WhatsAppChatRead, WhatsAppBridgeError>;
    /**
     * Queues one message proposal. It is sent only after the owner replies
     * "yes <id>" on WhatsApp. Not retried: a timeout means the outcome is
     * unknown and the caller must check WhatsApp before trying again.
     */
    readonly proposeMessage: (input: {
      readonly jid: string;
      readonly text: string;
    }) => Effect.Effect<WhatsAppProposal, WhatsAppBridgeError>;
  }
>()("t3/whatsapp/WhatsAppBridge") {}

export interface WhatsAppBridgeOptions {
  /** Absolute path to the bridge's MCP entry, or null when not configured. */
  readonly mcpScriptPath: string | null;
  readonly timeout?: Duration.Input;
}

interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
}

const MAX_PROPOSAL_LENGTH = 3000;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.trunc(Number.isFinite(value) ? value : min)));

const toolText = (result: unknown): ToolResult => {
  const record = (result ?? {}) as { content?: unknown; isError?: unknown };
  const parts = Array.isArray(record.content) ? record.content : [];
  const text = parts
    .flatMap((part) =>
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join("\n");
  return { text, isError: record.isError === true };
};

const unavailable = (detail: string) => new WhatsAppBridgeError({ reason: "unavailable", detail });
const invalidInput = (detail: string) =>
  new WhatsAppBridgeError({ reason: "invalidInput", detail });

export const make = (options: WhatsAppBridgeOptions) =>
  Effect.gen(function* () {
    const timeout = Duration.fromInputUnsafe(options.timeout ?? "15 seconds");
    const inFlightProposals = yield* Ref.make(new Set<string>());
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

    const callTool = (
      name: WhatsAppAllowedTool,
      args: Record<string, unknown>,
    ): Effect.Effect<ToolResult, WhatsAppBridgeError> => {
      const script = options.mcpScriptPath;
      if (script === null) {
        return Effect.fail(
          new WhatsAppBridgeError({
            reason: "notConfigured",
            detail: "No WhatsApp bridge is configured on this server.",
          }),
        );
      }
      if (!(WHATSAPP_ALLOWED_TOOLS as ReadonlyArray<string>).includes(name)) {
        return Effect.fail(invalidInput(`The WhatsApp tool "${name}" is not allowed.`));
      }
      return Effect.tryPromise({
        try: async (signal) => {
          const transport = new StdioClientTransport({
            command: process.execPath,
            args: ["--disable-warning=ExperimentalWarning", script],
            // Merged over the SDK's minimal default environment, so this server's
            // own secrets are not inherited. NESTED hides ask_assistant; the
            // allowlist above is what keeps the other mutating tools out of reach.
            env: { WA_MCP_NESTED: "1", WA_MCP_SOURCE: "t3-comms" },
            stderr: "ignore",
          });
          const client = new Client({ name: "t3-comms", version: "1.0.0" });
          const close = () => void client.close().catch(() => undefined);
          signal.addEventListener("abort", close, { once: true });
          try {
            await client.connect(transport, { signal });
            return toolText(
              await client.callTool({ name, arguments: args }, undefined, { signal }),
            );
          } finally {
            signal.removeEventListener("abort", close);
            await client.close().catch(() => undefined);
          }
        },
        catch: () => unavailable("The WhatsApp bridge did not respond."),
      }).pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.fail(unavailable("The WhatsApp bridge timed out.")),
        }),
      );
    };

    const rejectOnError = (result: ToolResult) =>
      result.isError
        ? Effect.fail(
            new WhatsAppBridgeError({
              reason: "rejected",
              detail: result.text.trim().slice(0, 300) || "The WhatsApp bridge refused it.",
            }),
          )
        : Effect.succeed(result.text);

    const getStatus: Effect.Effect<WhatsAppStatus> = Effect.gen(function* () {
      if (options.mcpScriptPath === null) return { _tag: "NotConfigured" } as const;
      const result = yield* callTool("status", {}).pipe(
        Effect.flatMap(rejectOnError),
        Effect.result,
      );
      const checkedAt = yield* nowIso;
      if (result._tag === "Failure") {
        return { _tag: "Unavailable", detail: result.failure.detail, checkedAt } as const;
      }
      const status = parseBridgeStatus(result.success);
      return status === null
        ? ({
            _tag: "Unavailable",
            detail: "The WhatsApp bridge answered in an unexpected format.",
            checkedAt,
          } as const)
        : ({ _tag: "Available", checkedAt, ...status } as const);
    });

    const listChats = ({ limit }: { readonly limit: number }) =>
      Effect.gen(function* () {
        const text = yield* callTool("list_chats", {
          limit: clamp(limit, 1, 100),
          include_groups: true,
        }).pipe(Effect.flatMap(rejectOnError));
        return { chats: parseChatList(text), checkedAt: yield* nowIso };
      });

    const readChat = ({ jid, limit }: { readonly jid: string; readonly limit: number }) =>
      Effect.gen(function* () {
        if (!isChatJid(jid)) return yield* invalidInput("Choose a chat by its WhatsApp id.");
        const text = yield* callTool("read_chat", { chat: jid, limit: clamp(limit, 1, 300) }).pipe(
          Effect.flatMap(rejectOnError),
        );
        const transcript = parseChatTranscript(text);
        if (transcript === null || transcript.jid !== jid) {
          return yield* unavailable("The WhatsApp bridge answered in an unexpected format.");
        }
        return { ...transcript, checkedAt: yield* nowIso };
      });

    const proposeMessage = ({ jid, text }: { readonly jid: string; readonly text: string }) =>
      Effect.gen(function* () {
        const body = text.trim();
        if (!isDirectChatJid(jid)) {
          return yield* invalidInput("Messages can only be proposed to one-to-one chats.");
        }
        if (body.length === 0 || body.length > MAX_PROPOSAL_LENGTH) {
          return yield* invalidInput(`Write a message of 1 to ${MAX_PROPOSAL_LENGTH} characters.`);
        }
        const key = `${jid}\u0000${body}`;
        const claimed = yield* Ref.modify(inFlightProposals, (keys) =>
          keys.has(key) ? [false, keys] : [true, new Set(keys).add(key)],
        );
        if (!claimed) {
          return yield* invalidInput("This message is already being proposed.");
        }
        return yield* callTool("send_message", { chat: jid, text: body }).pipe(
          Effect.mapError((error) =>
            error.reason === "unavailable"
              ? unavailable(
                  "The proposal's outcome is unknown. Check your WhatsApp self-chat before trying again.",
                )
              : error,
          ),
          Effect.flatMap(rejectOnError),
          Effect.map((confirmation) => {
            const proposalId = parseProposalId(confirmation);
            return {
              proposalId,
              detail:
                proposalId === null
                  ? confirmation.trim().slice(0, 300)
                  : `Queued as proposal #${proposalId}. Reply "yes ${proposalId}" in your WhatsApp self-chat to send it.`,
            };
          }),
          Effect.ensuring(
            Ref.update(inFlightProposals, (keys) => {
              const next = new Set(keys);
              next.delete(key);
              return next;
            }),
          ),
        );
      });

    return WhatsAppBridge.of({ getStatus, listChats, readChat, proposeMessage });
  });

export const layerWith = (options: WhatsAppBridgeOptions) =>
  Layer.effect(WhatsAppBridge, make(options));

export const layer = Layer.effect(
  WhatsAppBridge,
  Effect.suspend(() => make({ mcpScriptPath: process.env[WHATSAPP_MCP_ENV]?.trim() || null })),
);
