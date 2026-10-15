import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  isSidebarSubagentThread,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
  resolveThreadStatusPill,
} from "../components/Sidebar.logic";

export const ROLE_HUB_IDS = ["comms", "orchestrator", "mentor"] as const;
export type RoleHubId = (typeof ROLE_HUB_IDS)[number];

export function isRoleHubId(value: unknown): value is RoleHubId {
  return typeof value === "string" && (ROLE_HUB_IDS as readonly string[]).includes(value);
}

export interface RoleHubDefinition {
  readonly id: RoleHubId;
  readonly name: string;
  readonly shortName: string;
  readonly summary: string;
  /** Title fragments that suggest an existing thread already plays this role. */
  readonly suggestionPattern: RegExp;
  readonly referencePlaceholder: string;
}

export const ROLE_HUBS: Record<RoleHubId, RoleHubDefinition> = {
  comms: {
    id: "comms",
    name: "Comms",
    shortName: "Comms",
    summary: "People, conversations and outgoing messages. Nothing is sent without your approval.",
    suggestionPattern: /\b(comms|whatsapp|messages?|inbox)\b/i,
    referencePlaceholder: "Person, chat or channel, e.g. Alex (WhatsApp)",
  },
  orchestrator: {
    id: "orchestrator",
    name: "Orchestrator",
    shortName: "Orchestrator",
    summary: "Coordinates projects and agents, and collects what is ready for you to check.",
    suggestionPattern: /\b(orchestrat\w*|coordinat\w*|root)\b/i,
    referencePlaceholder: "Project, repository, dashboard or thread link",
  },
  mentor: {
    id: "mentor",
    name: "Mentor",
    shortName: "Mentor",
    summary: "Research & guidance: research swarms, library references and advice.",
    suggestionPattern: /\b(mentor|research|guidance|advice|library)\b/i,
    referencePlaceholder: "@book reference, paper, URL or topic",
  },
};

// ── Persisted state ────────────────────────────────────────────────────

export const ROLE_HUB_STORAGE_KEY = "t3code:role-hubs:v1";

export interface RoleHubReference {
  readonly id: string;
  readonly value: string;
  readonly addedAt: string;
}

export interface RoleHubRecord {
  readonly thread: ScopedThreadRef | null;
  readonly instructions: string;
  readonly instructionsSavedAt: string | null;
  readonly references: ReadonlyArray<RoleHubReference>;
}

export type RoleHubState = Record<RoleHubId, RoleHubRecord>;

const EMPTY_RECORD: RoleHubRecord = {
  thread: null,
  instructions: "",
  instructionsSavedAt: null,
  references: [],
};

export const INITIAL_ROLE_HUB_STATE: RoleHubState = {
  comms: EMPTY_RECORD,
  orchestrator: EMPTY_RECORD,
  mentor: EMPTY_RECORD,
};

const MAX_INSTRUCTIONS_LENGTH = 20_000;
const MAX_REFERENCES = 100;
const MAX_REFERENCE_LENGTH = 2_000;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function sanitizeThreadRef(value: unknown): ScopedThreadRef | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const environmentId = nonEmptyString(record.environmentId);
  const threadId = nonEmptyString(record.threadId);
  if (environmentId === null || threadId === null) return null;
  return scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId));
}

function sanitizeReferences(value: unknown): RoleHubReference[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const references: RoleHubReference[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = nonEmptyString(record.id);
    const referenceValue = nonEmptyString(record.value);
    if (id === null || referenceValue === null || seen.has(id)) continue;
    seen.add(id);
    references.push({
      id,
      value: referenceValue.slice(0, MAX_REFERENCE_LENGTH),
      addedAt: nonEmptyString(record.addedAt) ?? new Date(0).toISOString(),
    });
    if (references.length >= MAX_REFERENCES) break;
  }
  return references;
}

function sanitizeRecord(value: unknown): RoleHubRecord {
  if (!value || typeof value !== "object") return EMPTY_RECORD;
  const record = value as Record<string, unknown>;
  return {
    thread: sanitizeThreadRef(record.thread),
    instructions:
      typeof record.instructions === "string"
        ? record.instructions.slice(0, MAX_INSTRUCTIONS_LENGTH)
        : "",
    instructionsSavedAt: nonEmptyString(record.instructionsSavedAt),
    references: sanitizeReferences(record.references),
  };
}

/** Tolerates missing, partial, or corrupt storage: unknown input yields empty hubs. */
export function parseRoleHubState(raw: string | null): RoleHubState {
  if (raw === null) return INITIAL_ROLE_HUB_STATE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return INITIAL_ROLE_HUB_STATE;
  }
  if (!parsed || typeof parsed !== "object") return INITIAL_ROLE_HUB_STATE;
  const hubs = (parsed as Record<string, unknown>).hubs;
  if (!hubs || typeof hubs !== "object") return INITIAL_ROLE_HUB_STATE;
  const byId = hubs as Record<string, unknown>;
  return {
    comms: sanitizeRecord(byId.comms),
    orchestrator: sanitizeRecord(byId.orchestrator),
    mentor: sanitizeRecord(byId.mentor),
  };
}

export function serializeRoleHubState(state: RoleHubState): string {
  return JSON.stringify({ version: 1, hubs: state });
}

// ── Ready-for-you queue ───────────────────────────────────────────────

export type ReadyItemKind = "decide" | "review";

export type ReadyItemReason = "approval" | "input" | "plan" | "completed" | "failed";

export interface ReadyItem {
  readonly key: string;
  readonly threadRef: ScopedThreadRef;
  readonly kind: ReadyItemKind;
  readonly reason: ReadyItemReason;
  /** When the thing waiting for the user appeared; drives freshness. */
  readonly since: string;
  /** Latest assistant message when the shell carries one; detail fills it in otherwise. */
  readonly message: string | null;
  /** Completion time to record as reviewed; null for decisions. */
  readonly completedAt: string | null;
  readonly thread: EnvironmentThreadShell;
}

export const READY_REASON_LABEL: Record<ReadyItemReason, string> = {
  approval: "Approval needed",
  input: "Question for you",
  plan: "Plan to approve",
  completed: "Ready to review",
  failed: "Failed, check it",
};

function isoOf(value: DateTime.Utc | null | undefined): string | null {
  return value ? DateTime.formatIso(value) : null;
}

function isSnoozed(thread: EnvironmentThreadShell, nowMs: number): boolean {
  if (!thread.snoozedUntil) return false;
  const until = Date.parse(thread.snoozedUntil);
  return !Number.isNaN(until) && until > nowMs;
}

function latestAssistantText(thread: EnvironmentThreadShell): string | null {
  const message = thread.source.latestVisibleMessage;
  if (!message || message.role !== "assistant") return null;
  const text = message.text.trim();
  return text.length > 0 ? text : null;
}

/**
 * The newest finished assistant message in a thread's detail. Shells omit
 * message bodies, so queue cards read this once the card's detail loads.
 * Turn items carry the transcript; `messages` covers older projections.
 */
export function latestAssistantMessageText(input: {
  readonly turnItems: ReadonlyArray<{
    readonly type: string;
    readonly text?: string;
    readonly streaming?: boolean;
  }>;
  readonly messages: ReadonlyArray<{
    readonly role: string;
    readonly text: string;
    readonly streaming: boolean;
  }>;
}): string | null {
  const finished = (text: string | undefined, streaming: boolean | undefined) => {
    const trimmed = text?.trim() ?? "";
    return streaming !== true && trimmed.length > 0 ? trimmed : null;
  };
  for (let index = input.turnItems.length - 1; index >= 0; index -= 1) {
    const item = input.turnItems[index];
    if (item?.type !== "assistant_message") continue;
    const text = finished(item.text, item.streaming);
    if (text !== null) return text;
  }
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (message?.role !== "assistant") continue;
    const text = finished(message.text, message.streaming);
    if (text !== null) return text;
  }
  return null;
}

/**
 * Derives what is waiting on the user from live thread shells, reusing the
 * sidebar's own status rules so the queue and the rows never disagree.
 * Items leave the queue only when resolved: a decision is answered in its
 * thread, a review is opened or marked reviewed. Snoozed, archived, deleted,
 * and subagent threads are excluded.
 */
export function deriveReadyQueue(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly localLastVisitedAtByKey: Readonly<Record<string, string>>;
  readonly nowMs: number;
}): ReadyItem[] {
  const items: ReadyItem[] = [];
  for (const thread of input.threads) {
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    if (isSidebarSubagentThread(thread) || isSnoozed(thread, input.nowMs)) continue;
    const threadRef = scopeThreadRef(thread.environmentId, thread.id);
    const key = scopedThreadKey(threadRef);
    const lastVisitedAt = resolveThreadLastVisitedAt(
      thread.lastVisitedAt,
      input.localLastVisitedAtByKey[key],
    );
    const pill = resolveThreadStatusPill({ thread: { ...thread, lastVisitedAt } });
    if (pill === null) continue;
    const pendingSince = isoOf(thread.source.pendingRuntimeRequest?.createdAt) ?? thread.updatedAt;
    const message = latestAssistantText(thread);
    const base = { key, threadRef, message, thread };
    switch (pill.label) {
      case "Pending Approval":
        items.push({
          ...base,
          kind: "decide",
          reason: "approval",
          since: pendingSince,
          completedAt: null,
        });
        break;
      case "Awaiting Input":
        items.push({
          ...base,
          kind: "decide",
          reason: "input",
          since: pendingSince,
          completedAt: null,
        });
        break;
      case "Plan Ready":
        items.push({
          ...base,
          kind: "decide",
          reason: "plan",
          since: thread.updatedAt,
          completedAt: null,
        });
        break;
      case "Completed": {
        const completedAt = thread.latestRun?.completedAt ?? thread.updatedAt;
        const status = resolveSidebarThreadStatus(thread);
        items.push({
          ...base,
          kind: "review",
          reason: status === "failed" || status === "limited" ? "failed" : "completed",
          since: completedAt,
          completedAt,
        });
        break;
      }
      default:
        break;
    }
  }
  return items.toSorted((a, b) => {
    if (a.kind !== b.kind) return a.kind === "decide" ? -1 : 1;
    return Date.parse(b.since) - Date.parse(a.since);
  });
}

export interface ReadyQueueCounts {
  readonly decide: number;
  readonly review: number;
}

export function countReadyQueue(items: ReadonlyArray<ReadyItem>): ReadyQueueCounts {
  let decide = 0;
  let review = 0;
  for (const item of items) {
    if (item.kind === "decide") decide += 1;
    else review += 1;
  }
  return { decide, review };
}

// ── Project mini dashboard ─────────────────────────────────────────────

export interface ProjectDashboardEntry {
  readonly key: string;
  readonly environmentId: EnvironmentThreadShell["environmentId"];
  readonly projectId: EnvironmentThreadShell["projectId"];
  readonly working: number;
  readonly decide: number;
  readonly review: number;
  readonly openThreads: number;
  readonly lastActivityAt: string;
}

/** Per-project activity from the same shells, busiest and freshest first. */
export function deriveProjectDashboard(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly readyItems: ReadonlyArray<ReadyItem>;
}): ProjectDashboardEntry[] {
  const readyByThreadKey = new Map(input.readyItems.map((item) => [item.key, item.kind]));
  const byProject = new Map<string, ProjectDashboardEntry>();
  for (const thread of input.threads) {
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    if (isSidebarSubagentThread(thread)) continue;
    const key = `${thread.environmentId}:${thread.projectId}`;
    const previous = byProject.get(key);
    const readyKind = readyByThreadKey.get(
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    );
    const isWorking = resolveSidebarThreadStatus(thread) === "working";
    const isOpen = thread.settledAt === null || thread.settledOverride === "active";
    byProject.set(key, {
      key,
      environmentId: thread.environmentId,
      projectId: thread.projectId,
      working: (previous?.working ?? 0) + (isWorking ? 1 : 0),
      decide: (previous?.decide ?? 0) + (readyKind === "decide" ? 1 : 0),
      review: (previous?.review ?? 0) + (readyKind === "review" ? 1 : 0),
      openThreads: (previous?.openThreads ?? 0) + (isOpen ? 1 : 0),
      lastActivityAt:
        previous && Date.parse(previous.lastActivityAt) > Date.parse(thread.updatedAt)
          ? previous.lastActivityAt
          : thread.updatedAt,
    });
  }
  const attention = (entry: ProjectDashboardEntry) =>
    entry.decide * 4 + entry.review * 2 + entry.working;
  return [...byProject.values()]
    .filter((entry) => entry.openThreads > 0 || attention(entry) > 0)
    .toSorted(
      (a, b) =>
        attention(b) - attention(a) || Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
    );
}

/** Threads whose titles suggest they already play a role, newest first. */
export function suggestRoleThreads(
  role: RoleHubId,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): EnvironmentThreadShell[] {
  const pattern = ROLE_HUBS[role].suggestionPattern;
  return threads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        !isSidebarSubagentThread(thread) &&
        pattern.test(thread.title),
    )
    .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
