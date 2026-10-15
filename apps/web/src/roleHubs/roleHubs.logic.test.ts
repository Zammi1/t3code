import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, RunId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeThreadFixture } from "../test-fixtures";
import { PERSISTED_STATE_KEY, parsePersistedState, type PersistedUiState } from "../uiStateStore";
import {
  INITIAL_ROLE_HUB_STATE,
  ROLE_HUB_STORAGE_KEY,
  countReadyQueue,
  deriveProjectDashboard,
  deriveReadyQueue,
  latestAssistantMessageText,
  parseRoleHubState,
  serializeRoleHubState,
  suggestRoleThreads,
} from "./roleHubs.logic";

const environmentId = EnvironmentId.make("environment-test");
const NOW_MS = Date.parse("2026-10-15T12:00:00.000Z");

type ShellSource = ReturnType<typeof makeThreadFixture>["source"];

function shell(id: string, overrides: Partial<ShellSource> = {}) {
  const base = makeThreadFixture({ id: ThreadId.make(id) }).source;
  return presentThreadShell(environmentId, { ...base, title: id, ...overrides });
}

function pending(kind: "command" | "user_input", createdAt = "2026-10-15T11:30:00.000Z") {
  return {
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make(`request-${kind}`),
      kind,
      createdAt: DateTime.makeUnsafe(createdAt),
    },
  } satisfies Partial<ShellSource>;
}

function completed(id: string, completedAt: string, visitedAt: string | null) {
  return shell(id, {
    latestRunId: RunId.make(`run-${id}`),
    status: "completed",
    latestRunCompletedAt: DateTime.makeUnsafe(completedAt),
    lastVisitedAt: visitedAt === null ? null : DateTime.makeUnsafe(visitedAt),
    latestVisibleMessage: {
      id: `message-${id}` as never,
      role: "assistant",
      text: "Done. ![after](/tmp/after.png)\n\nShip it?",
      updatedAt: DateTime.makeUnsafe(completedAt),
    },
  });
}

describe("deriveReadyQueue", () => {
  it("puts decisions before reviews and keeps the agent's latest message", () => {
    const approval = shell("approval", { ...pending("command") });
    const review = completed("review", "2026-10-15T11:00:00.000Z", "2026-10-15T10:00:00.000Z");
    const items = deriveReadyQueue({
      threads: [review, approval],
      localLastVisitedAtByKey: {},
      nowMs: NOW_MS,
    });

    expect(items.map((item) => [item.thread.title, item.kind, item.reason])).toEqual([
      ["approval", "decide", "approval"],
      ["review", "review", "completed"],
    ]);
    expect(items[1]?.message).toContain("![after](/tmp/after.png)");
    expect(items[1]?.completedAt).toBe("2026-10-15T11:00:00.000Z");
    expect(countReadyQueue(items)).toEqual({ decide: 1, review: 1 });
  });

  it("keeps a review until it is visited, then drops it", () => {
    const seen = completed("seen", "2026-10-15T11:00:00.000Z", "2026-10-15T11:05:00.000Z");
    const unseen = completed("unseen", "2026-10-15T11:00:00.000Z", "2026-10-15T10:00:00.000Z");
    const items = deriveReadyQueue({
      threads: [seen, unseen],
      localLastVisitedAtByKey: {},
      nowMs: NOW_MS,
    });
    expect(items.map((item) => item.thread.title)).toEqual(["unseen"]);
  });

  it("excludes snoozed, archived, and subagent threads", () => {
    const snoozed = shell("snoozed", {
      ...pending("user_input"),
      snoozedUntil: DateTime.makeUnsafe("2026-10-16T00:00:00.000Z"),
    });
    const archived = shell("archived", {
      ...pending("user_input"),
      archivedAt: DateTime.makeUnsafe("2026-10-14T00:00:00.000Z"),
    });
    const subagent = shell("subagent", {
      ...pending("user_input"),
      lineage: {
        rootThreadId: ThreadId.make("root"),
        parentThreadId: ThreadId.make("root"),
        relationshipToParent: "subagent",
      },
    });
    const input = shell("input", { ...pending("user_input") });
    const items = deriveReadyQueue({
      threads: [snoozed, archived, subagent, input],
      localLastVisitedAtByKey: {},
      nowMs: NOW_MS,
    });
    expect(items.map((item) => [item.thread.title, item.reason])).toEqual([["input", "input"]]);
  });
});

describe("latestAssistantMessageText", () => {
  it("returns the newest finished assistant text from turn items", () => {
    expect(
      latestAssistantMessageText({
        turnItems: [
          {
            type: "assistant_message",
            text: "Which option? ![shot](/tmp/a.png)",
            streaming: false,
          },
          { type: "user_message", text: "B" },
          { type: "assistant_message", text: "Half written", streaming: true },
        ],
        messages: [],
      }),
    ).toBe("Which option? ![shot](/tmp/a.png)");
  });

  it("falls back to messages and ignores blank or streaming text", () => {
    expect(
      latestAssistantMessageText({
        turnItems: [],
        messages: [
          { role: "assistant", text: "Done.", streaming: false },
          { role: "assistant", text: "  ", streaming: false },
        ],
      }),
    ).toBe("Done.");
    expect(latestAssistantMessageText({ turnItems: [], messages: [] })).toBeNull();
  });
});

describe("deriveProjectDashboard", () => {
  it("counts attention per project, busiest first", () => {
    const quiet = shell("quiet", { projectId: ProjectId.make("project-quiet") });
    const busy = shell("busy", {
      projectId: ProjectId.make("project-busy"),
      ...pending("command"),
    });
    const threads = [quiet, busy];
    const readyItems = deriveReadyQueue({ threads, localLastVisitedAtByKey: {}, nowMs: NOW_MS });
    const dashboard = deriveProjectDashboard({ threads, readyItems });
    expect(dashboard.map((entry) => [entry.projectId, entry.decide, entry.openThreads])).toEqual([
      ["project-busy", 1, 1],
      ["project-quiet", 0, 1],
    ]);
  });
});

describe("suggestRoleThreads", () => {
  it("suggests an existing coordinator thread for the orchestrator", () => {
    const coordinator = shell("Root OVH coordinator");
    const other = shell("Fix login bug");
    expect(suggestRoleThreads("orchestrator", [other, coordinator]).map((t) => t.title)).toEqual([
      "Root OVH coordinator",
    ]);
  });
});

describe("role hub persistence", () => {
  it("falls back to empty hubs for missing or corrupt storage", () => {
    expect(parseRoleHubState(null)).toEqual(INITIAL_ROLE_HUB_STATE);
    expect(parseRoleHubState("{not json")).toEqual(INITIAL_ROLE_HUB_STATE);
    expect(parseRoleHubState(JSON.stringify({ hubs: "nope" }))).toEqual(INITIAL_ROLE_HUB_STATE);
  });

  it("round-trips hubs and drops malformed entries", () => {
    const state = parseRoleHubState(
      JSON.stringify({
        hubs: {
          orchestrator: {
            thread: { environmentId: "env-a", threadId: "thread-a" },
            instructions: "Coordinate releases",
            instructionsSavedAt: "2026-10-15T10:00:00.000Z",
            references: [
              { id: "r1", value: "github.com/acme/app", addedAt: "2026-10-15T10:00:00.000Z" },
              { id: "r1", value: "duplicate id" },
              { id: "", value: "missing id" },
              { id: "r2", value: "   " },
            ],
          },
          mentor: { thread: { environmentId: "env-a" } },
        },
      }),
    );
    expect(state.orchestrator.thread).toEqual({ environmentId: "env-a", threadId: "thread-a" });
    expect(state.orchestrator.references.map((reference) => reference.value)).toEqual([
      "github.com/acme/app",
    ]);
    expect(state.mentor.thread).toBeNull();
    expect(parseRoleHubState(serializeRoleHubState(state))).toEqual(state);
  });
});

// Pins and their order are server-side thread fields; recents, visit marks,
// project order, and shelf preferences live in other localStorage keys. A
// hub upgrade must leave every one of those bytes alone.
describe("role hub store preserves existing sidebar state", () => {
  const storage = new Map<string, string>();
  const existingUiState: PersistedUiState = {
    projectOrder: ["project-b", "project-a"],
    projectExpandedById: { "project-a": false },
    threadLastVisitedAtById: { "environment-test:thread-1": "2026-10-15T09:00:00.000Z" },
    sidebarProjectScopeKey: "project-a",
  };
  const existingEntries: Record<string, string> = {
    [PERSISTED_STATE_KEY]: JSON.stringify(existingUiState),
    "t3code:sidebar-settled-shelf-expanded": "true",
    "t3code:client-settings:v1": JSON.stringify({ sidebarThreadSortOrder: "updated_at" }),
  };

  beforeEach(() => {
    storage.clear();
    for (const [key, value] of Object.entries(existingEntries)) storage.set(key, value);
    const localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() {
        return storage.size;
      },
    };
    vi.stubGlobal("window", { localStorage, addEventListener: () => undefined });
    vi.stubGlobal("localStorage", localStorage);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes only its own key while hubs are linked and edited", async () => {
    const { useRoleHubStore } = await import("./roleHubStore");
    const store = useRoleHubStore.getState();
    store.linkThread("orchestrator", {
      environmentId: environmentId,
      threadId: ThreadId.make("thread-1"),
    });
    store.saveInstructions("mentor", "Cite sources.");
    store.addReference("comms", "Alex (WhatsApp)");
    store.linkThread("orchestrator", null);

    for (const [key, value] of Object.entries(existingEntries)) {
      expect(storage.get(key)).toBe(value);
    }
    expect([...storage.keys()].toSorted()).toEqual(
      [...Object.keys(existingEntries), ROLE_HUB_STORAGE_KEY].toSorted(),
    );
    expect(parsePersistedState(existingUiState)).toMatchObject({
      projectOrder: ["project-b", "project-a"],
      threadLastVisitedAtById: { "environment-test:thread-1": "2026-10-15T09:00:00.000Z" },
    });
    const saved = parseRoleHubState(storage.get(ROLE_HUB_STORAGE_KEY) ?? null);
    expect(saved.mentor.instructions).toBe("Cite sources.");
    expect(saved.comms.references.map((reference) => reference.value)).toEqual(["Alex (WhatsApp)"]);
  });
});
