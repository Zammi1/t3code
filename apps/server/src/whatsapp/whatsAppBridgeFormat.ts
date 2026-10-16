/**
 * Parsers for the text the wa-agent `wa` MCP server returns.
 *
 * The bridge formats its tool results for agents to read, not as a stable
 * API, so everything here is tolerant: a line it cannot read is skipped or
 * kept as plain text rather than failing the whole result. The status tool is
 * the one structured (JSON) result; only the fields the Comms hub shows are
 * kept, so standing instructions, the linked number, and the text or
 * recipients of pending proposals never leave the server.
 */
import * as DateTime from "effect/DateTime";

export type WhatsAppLinkState = "linked" | "waiting_for_qr" | "logged_out" | "unknown";

export interface WhatsAppBridgeStatus {
  readonly link: WhatsAppLinkState;
  /** When the bridge last recorded a link change; not a heartbeat. */
  readonly linkChangedAt: string | null;
  readonly awayOn: boolean;
  readonly awayUntil: string | null;
  /** Proposals queued or awaiting "yes <id>" on WhatsApp. Count only. */
  readonly pendingProposals: number;
  readonly autoRepliesLast24h: number;
}

export interface WhatsAppChatSummary {
  readonly jid: string;
  readonly name: string;
  readonly isGroup: boolean;
  readonly lastActivityAt: string | null;
  /** Away-mode setting for the person (brief, sales, ignore), when one is set. */
  readonly mode: string | null;
}

export interface WhatsAppChatMessage {
  readonly at: string | null;
  readonly from: string;
  readonly fromMe: boolean;
  /** Sent by the bridge's away mode rather than typed by the owner. */
  readonly automatic: boolean;
  readonly text: string;
  /** File id usable with the bridge's get_file tool, when the message has media. */
  readonly fileId: string | null;
}

export interface WhatsAppChatTranscript {
  readonly jid: string;
  readonly name: string;
  readonly messages: ReadonlyArray<WhatsAppChatMessage>;
}

const LINK_STATES = new Set<WhatsAppLinkState>(["linked", "waiting_for_qr", "logged_out"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const epochSecondsToIso = (value: unknown): string | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? DateTime.formatIso(DateTime.makeUnsafe(value * 1000))
    : null;

const nonNegativeInt = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;

/** Reads the `status` tool's JSON. Returns null when it is not JSON at all. */
export function parseBridgeStatus(text: string): WhatsAppBridgeStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const link = isRecord(parsed.link) ? parsed.link : {};
  const away = isRecord(parsed.away) ? parsed.away : {};
  const state = typeof link.state === "string" ? link.state : "";
  return {
    link: LINK_STATES.has(state as WhatsAppLinkState) ? (state as WhatsAppLinkState) : "unknown",
    linkChangedAt: epochSecondsToIso(link.at),
    awayOn: away.on === true,
    awayUntil: away.on === true ? epochSecondsToIso(away.until) : null,
    pendingProposals: Array.isArray(parsed.pending) ? parsed.pending.length : 0,
    autoRepliesLast24h: nonNegativeInt(parsed.autoRepliesLast24h),
  };
}

// The bridge prints `new Date(ts * 1000).toISOString()` cut to minutes, so it is UTC.
const BRIDGE_MINUTE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/;
const bridgeMinuteToIso = (value: string): string | null => {
  const match = BRIDGE_MINUTE.exec(value);
  return match ? `${match[1]}T${match[2]}:00.000Z` : null;
};

// `2026-10-16 09:30  Name (group) [mode]  123@g.us`
const CHAT_LINE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) {2}(.*) {2}(\S+@\S+)$/;

export function parseChatList(text: string): ReadonlyArray<WhatsAppChatSummary> {
  const chats: WhatsAppChatSummary[] = [];
  for (const line of text.split("\n")) {
    const match = CHAT_LINE.exec(line.trimEnd());
    if (!match) continue;
    let name = match[2]!.trim();
    let mode: string | null = null;
    const modeMatch = / \[([a-z]+)\]$/.exec(name);
    if (modeMatch) {
      mode = modeMatch[1]!;
      name = name.slice(0, modeMatch.index);
    }
    const isGroup = name.endsWith(" (group)");
    if (isGroup) name = name.slice(0, -" (group)".length);
    chats.push({
      jid: match[3]!,
      name: name.trim() || "?",
      isGroup,
      lastActivityAt: bridgeMinuteToIso(match[1]!),
      mode,
    });
  }
  return chats;
}

const HEADER_LINE = /^Chat: (.*) \((\S+@\S+)\)$/;
const MESSAGE_LINE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] ([^:\n]*): ?(.*)$/;
const FILE_SUFFIX = / \{file ([^\s{}]+)\}$/;
// The bridge labels the linked account's own messages with this fixed name.
const OWNER_LABEL = "Sammy";
const OWNER_AUTO_LABEL = `${OWNER_LABEL} (auto)`;

/**
 * Reads the `read_chat` transcript. A message's text can span several lines,
 * so lines without a `[timestamp]` prefix continue the previous message.
 */
export function parseChatTranscript(text: string): WhatsAppChatTranscript | null {
  const lines = text.split("\n");
  const header = HEADER_LINE.exec(lines[0] ?? "");
  if (!header) return null;
  const messages: Array<{ -readonly [K in keyof WhatsAppChatMessage]: WhatsAppChatMessage[K] }> =
    [];
  for (const line of lines.slice(1)) {
    const match = MESSAGE_LINE.exec(line);
    if (match) {
      const from = match[2]!;
      messages.push({
        at: bridgeMinuteToIso(match[1]!),
        from,
        fromMe: from === OWNER_LABEL || from === OWNER_AUTO_LABEL,
        automatic: from === OWNER_AUTO_LABEL,
        text: match[3]!,
        fileId: null,
      });
      continue;
    }
    const last = messages.at(-1);
    if (last) last.text = `${last.text}\n${line}`;
  }
  for (const message of messages) {
    const file = FILE_SUFFIX.exec(message.text);
    if (file) {
      message.fileId = file[1]!;
      message.text = message.text.slice(0, file.index);
    }
  }
  return { name: header[1]!, jid: header[2]!, messages };
}

/** Reads the proposal id from `send_message`'s "Proposal #12 to ..." confirmation. */
export function parseProposalId(text: string): number | null {
  const match = /^Proposal #(\d+)\b/.exec(text.trim());
  return match ? Number(match[1]) : null;
}

/** One-to-one chats only; the bridge refuses to propose messages to groups. */
export const isDirectChatJid = (jid: string): boolean =>
  /^[^@\s]+@(s\.whatsapp\.net|lid)$/.test(jid);

/** Any concrete jid. Names are refused so the bridge never fuzzy-matches a chat. */
export const isChatJid = (jid: string): boolean => /^[^@\s]+@[a-z.]+$/.test(jid);
