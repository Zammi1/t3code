import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import { randomUUID } from "../lib/utils";
import {
  INITIAL_ROLE_HUB_STATE,
  ROLE_HUB_STORAGE_KEY,
  parseRoleHubState,
  serializeRoleHubState,
  type RoleHubId,
  type RoleHubRecord,
  type RoleHubState,
} from "./roleHubs.logic";

/**
 * Role hubs persist under their own localStorage key. They never read or
 * write the sidebar's UI state, so pins, recents, ordering, and shelf
 * preferences are untouched by adding, editing, or clearing a hub.
 */
function readRoleHubState(): RoleHubState {
  if (typeof window === "undefined") return INITIAL_ROLE_HUB_STATE;
  try {
    return parseRoleHubState(window.localStorage.getItem(ROLE_HUB_STORAGE_KEY));
  } catch {
    return INITIAL_ROLE_HUB_STATE;
  }
}

function writeRoleHubState(state: RoleHubState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ROLE_HUB_STORAGE_KEY, serializeRoleHubState(state));
  } catch {
    // Quota or privacy-mode failures keep the in-memory state for this session.
  }
}

interface RoleHubStore {
  readonly hubs: RoleHubState;
  readonly linkThread: (role: RoleHubId, thread: ScopedThreadRef | null) => void;
  readonly saveInstructions: (role: RoleHubId, instructions: string) => void;
  readonly addReference: (role: RoleHubId, value: string) => void;
  readonly removeReference: (role: RoleHubId, referenceId: string) => void;
}

function updateHub(
  hubs: RoleHubState,
  role: RoleHubId,
  update: (record: RoleHubRecord) => RoleHubRecord,
): RoleHubState {
  const next = { ...hubs, [role]: update(hubs[role]) };
  writeRoleHubState(next);
  return next;
}

export const useRoleHubStore = create<RoleHubStore>((set) => ({
  hubs: readRoleHubState(),
  linkThread: (role, thread) =>
    set((state) => ({ hubs: updateHub(state.hubs, role, (record) => ({ ...record, thread })) })),
  saveInstructions: (role, instructions) =>
    set((state) => ({
      hubs: updateHub(state.hubs, role, (record) => ({
        ...record,
        instructions,
        instructionsSavedAt: new Date().toISOString(),
      })),
    })),
  addReference: (role, value) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    set((state) => ({
      hubs: updateHub(state.hubs, role, (record) =>
        record.references.some((reference) => reference.value === trimmed)
          ? record
          : {
              ...record,
              references: [
                ...record.references,
                { id: randomUUID(), value: trimmed, addedAt: new Date().toISOString() },
              ],
            },
      ),
    }));
  },
  removeReference: (role, referenceId) =>
    set((state) => ({
      hubs: updateHub(state.hubs, role, (record) => ({
        ...record,
        references: record.references.filter((reference) => reference.id !== referenceId),
      })),
    })),
}));

// Another window or tab editing hubs updates this one.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== ROLE_HUB_STORAGE_KEY) return;
    useRoleHubStore.setState({ hubs: parseRoleHubState(event.newValue) });
  });
}
