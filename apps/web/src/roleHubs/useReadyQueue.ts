import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { useNowMinute } from "../hooks/useNowMinute";
import { useThreadProjection, useThreadShells } from "../state/entities";
import { environmentThreadDetails } from "../state/threads";
import { useUiStateStore } from "../uiStateStore";
import { countReadyQueue, deriveReadyQueue, latestAssistantMessageText } from "./roleHubs.logic";

/** Live "Ready for you" queue from every connected environment's thread shells. */
export function useReadyQueue() {
  const threads = useThreadShells();
  const localLastVisitedAtByKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  // Snoozes expire on the clock, not on a shell event.
  const nowMinute = useNowMinute();
  return useMemo(() => {
    const items = deriveReadyQueue({
      threads,
      localLastVisitedAtByKey,
      nowMs: Date.parse(`${nowMinute}:00.000Z`),
    });
    return { threads, items, counts: countReadyQueue(items) };
  }, [localLastVisitedAtByKey, nowMinute, threads]);
}

const NO_PENDING_REQUESTS_ATOM = Atom.make(null).pipe(
  Atom.withLabel("role-hub-no-pending-requests"),
);

/**
 * Detail a queue card shows: the agent's latest message and any pending
 * approval or question. Pass null until the card is near the viewport so
 * only visible cards open a thread stream.
 */
export function useReadyItemDetail(ref: ScopedThreadRef | null) {
  const projection = useThreadProjection(ref);
  const pending = useAtomValue(
    ref === null ? NO_PENDING_REQUESTS_ATOM : environmentThreadDetails.pendingRequestsAtom(ref),
  );
  // Bounded snapshots fill the projected rows; full projections fill turnItems.
  const visibleTurnItems = projection?.projection.visibleTurnItems;
  const turnItems = projection?.projection.turnItems;
  const messages = projection?.projection.messages;
  const message = useMemo(() => {
    if (!visibleTurnItems || !turnItems || !messages) return null;
    return latestAssistantMessageText({
      turnItems: visibleTurnItems.length > 0 ? visibleTurnItems.map((row) => row.item) : turnItems,
      messages,
    });
  }, [messages, turnItems, visibleTurnItems]);
  return { loaded: projection !== null, message, pending };
}
