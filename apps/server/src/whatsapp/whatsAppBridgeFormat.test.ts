// @effect-diagnostics globalDate:off
import { describe, expect, it } from "vite-plus/test";

import {
  isChatJid,
  isDirectChatJid,
  parseBridgeStatus,
  parseChatList,
  parseChatTranscript,
  parseProposalId,
} from "./whatsAppBridgeFormat.ts";

describe("parseBridgeStatus", () => {
  it("keeps only link, away, and counts", () => {
    const status = parseBridgeStatus(
      JSON.stringify({
        away: { on: true, note: "at a shoot", until: 1_760_000_000 },
        link: { state: "linked", number: "447700900000", at: 1_759_990_000 },
        instructions: "I'm fully booked until November",
        pending: [
          { id: 4, kind: "message", chat: "1@s.whatsapp.net", text: "private", to: "Kate" },
          { id: 5, kind: "setting", chat: "", text: "away on" },
        ],
        autoRepliesLast24h: 3,
      }),
    );
    expect(status).toEqual({
      link: "linked",
      linkChangedAt: new Date(1_759_990_000_000).toISOString(),
      awayOn: true,
      awayUntil: new Date(1_760_000_000_000).toISOString(),
      pendingProposals: 2,
      autoRepliesLast24h: 3,
    });
    const serialized = JSON.stringify(status);
    for (const secret of ["447700900000", "booked", "private", "Kate", "at a shoot"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("reports an unknown link instead of assuming linked", () => {
    expect(parseBridgeStatus(JSON.stringify({ link: {}, away: { on: false } }))).toMatchObject({
      link: "unknown",
      linkChangedAt: null,
      awayOn: false,
      awayUntil: null,
      pendingProposals: 0,
    });
    expect(parseBridgeStatus(JSON.stringify({ link: { state: "open" } }))?.link).toBe("unknown");
  });

  it("returns null for text that is not a JSON object", () => {
    expect(parseBridgeStatus("Database is locked")).toBeNull();
    expect(parseBridgeStatus("[]")).toBeNull();
  });
});

describe("parseChatList", () => {
  it("reads names, groups, modes, and UTC minute timestamps", () => {
    const chats = parseChatList(
      [
        "2026-10-16 09:30  Kate [brief]  447700900001@s.whatsapp.net",
        "2026-10-15 18:02  Shoot crew (group)  120363000000000001@g.us",
        "2026-10-14 07:00  ?  98765@lid",
        "not a chat line",
      ].join("\n"),
    );
    expect(chats).toEqual([
      {
        jid: "447700900001@s.whatsapp.net",
        name: "Kate",
        isGroup: false,
        lastActivityAt: "2026-10-16T09:30:00.000Z",
        mode: "brief",
      },
      {
        jid: "120363000000000001@g.us",
        name: "Shoot crew",
        isGroup: true,
        lastActivityAt: "2026-10-15T18:02:00.000Z",
        mode: null,
      },
      {
        jid: "98765@lid",
        name: "?",
        isGroup: false,
        lastActivityAt: "2026-10-14T07:00:00.000Z",
        mode: null,
      },
    ]);
  });

  it("returns no chats for the bridge's empty message", () => {
    expect(parseChatList("No chats yet.")).toEqual([]);
  });
});

describe("parseChatTranscript", () => {
  it("joins multi-line messages and splits off file ids", () => {
    const transcript = parseChatTranscript(
      [
        "Chat: Kate (447700900001@s.whatsapp.net)",
        "[2026-10-16 09:00] Kate: Hi, are you free Thursday?",
        "Second line: with a colon",
        "[2026-10-16 09:01] Sammy (auto): Thanks, back soon.",
        "[2026-10-16 09:05] Sammy: Yes (shows: a calendar) {file 3EB0ABC}",
      ].join("\n"),
    );
    expect(transcript).toEqual({
      name: "Kate",
      jid: "447700900001@s.whatsapp.net",
      messages: [
        {
          at: "2026-10-16T09:00:00.000Z",
          from: "Kate",
          fromMe: false,
          automatic: false,
          text: "Hi, are you free Thursday?\nSecond line: with a colon",
          fileId: null,
        },
        {
          at: "2026-10-16T09:01:00.000Z",
          from: "Sammy (auto)",
          fromMe: true,
          automatic: true,
          text: "Thanks, back soon.",
          fileId: null,
        },
        {
          at: "2026-10-16T09:05:00.000Z",
          from: "Sammy",
          fromMe: true,
          automatic: false,
          text: "Yes (shows: a calendar)",
          fileId: "3EB0ABC",
        },
      ],
    });
  });

  it("reads an empty chat and rejects text without the chat header", () => {
    expect(
      parseChatTranscript("Chat: Kate (1@s.whatsapp.net)\nNo messages stored.")?.messages,
    ).toEqual([]);
    expect(parseChatTranscript('No chat matches "Kate".')).toBeNull();
  });
});

describe("ids", () => {
  it("parses the proposal id from the bridge confirmation", () => {
    expect(
      parseProposalId('Proposal #42 to Kate queued. Sammy must reply "yes 42" on WhatsApp.'),
    ).toBe(42);
    expect(parseProposalId("Queued.")).toBeNull();
  });

  it("only treats one-to-one jids as proposable", () => {
    expect(isDirectChatJid("447700900001@s.whatsapp.net")).toBe(true);
    expect(isDirectChatJid("98765@lid")).toBe(true);
    expect(isDirectChatJid("120363000000000001@g.us")).toBe(false);
    expect(isDirectChatJid("Kate")).toBe(false);
    expect(isChatJid("120363000000000001@g.us")).toBe(true);
    expect(isChatJid("Kate")).toBe(false);
  });
});
