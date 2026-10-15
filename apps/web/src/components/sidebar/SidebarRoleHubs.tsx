import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { GraduationCapIcon, MessagesSquareIcon, WorkflowIcon, type LucideIcon } from "lucide-react";
import { memo, useCallback } from "react";

import { cn } from "../../lib/utils";
import { ROLE_HUB_IDS, ROLE_HUBS, type RoleHubId } from "../../roleHubs/roleHubs.logic";
import { useRoleHubStore } from "../../roleHubs/roleHubStore";
import { useReadyQueue } from "../../roleHubs/useReadyQueue";
import { useThreadShell } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { resolveThreadLastVisitedAt, resolveThreadStatusPill } from "../Sidebar.logic";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const ROLE_HUB_ICONS: Record<RoleHubId, LucideIcon> = {
  comms: MessagesSquareIcon,
  orchestrator: WorkflowIcon,
  mentor: GraduationCapIcon,
};

function CountBadge(props: { count: number; tone: "decide" | "review"; label: string }) {
  if (props.count === 0) return null;
  return (
    <span
      aria-label={props.label}
      className={cn(
        "min-w-4 rounded-full px-1 text-center text-3xs font-semibold leading-4 tabular-nums",
        props.tone === "decide"
          ? "bg-warning/16 text-warning-foreground"
          : "bg-success/16 text-success-foreground",
      )}
    >
      {props.count}
    </span>
  );
}

/** Status dot for the role's own conversation, using the sidebar row's colors. */
function useLinkedThreadSignal(role: RoleHubId) {
  const threadRef = useRoleHubStore((state) => state.hubs[role].thread);
  const thread = useThreadShell(threadRef);
  const localLastVisitedAt = useUiStateStore((state) =>
    threadRef ? state.threadLastVisitedAtById[scopedThreadKey(threadRef)] : undefined,
  );
  if (threadRef === null) return { title: null, pill: null, missing: false };
  if (thread === null) return { title: null, pill: null, missing: true };
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  return {
    title: thread.title,
    pill: resolveThreadStatusPill({ thread: { ...thread, lastVisitedAt } }),
    missing: false,
  };
}

const RoleHubCard = memo(function RoleHubCard(props: {
  role: RoleHubId;
  active: boolean;
  decide: number;
  review: number;
  onOpen: (role: RoleHubId) => void;
}) {
  const hub = ROLE_HUBS[props.role];
  const Icon = ROLE_HUB_ICONS[props.role];
  const signal = useLinkedThreadSignal(props.role);
  const isOrchestrator = props.role === "orchestrator";
  const queueLabel = `${props.decide} decision${props.decide === 1 ? "" : "s"} needed, ${props.review} ready to review`;
  const conversationLabel = signal.missing
    ? "Linked conversation is not available on connected environments"
    : signal.title
      ? `Conversation: ${signal.title}${signal.pill ? ` (${signal.pill.label})` : ""}`
      : "No conversation linked yet";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-testid={`sidebar-role-hub-${props.role}`}
            data-active={props.active}
            aria-current={props.active ? "page" : undefined}
            aria-label={`${hub.name}${isOrchestrator ? `: ${queueLabel}` : ""}`}
            onClick={() => props.onOpen(props.role)}
            className="flex min-w-0 flex-col gap-1 rounded-lg border border-sidebar-border/70 px-1.5 py-1.5 text-left text-sidebar-muted-foreground outline-none transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[active=true]:border-ring/40 data-[active=true]:bg-sidebar-row-active data-[active=true]:text-sidebar-foreground"
          >
            <span className="flex h-4 w-full items-center justify-between gap-1">
              <Icon className="size-3.5 shrink-0 text-(--sidebar-icon-color)" aria-hidden />
              <span className="flex min-w-0 items-center gap-0.5">
                {isOrchestrator ? (
                  <>
                    <CountBadge count={props.decide} tone="decide" label="Decisions needed" />
                    <CountBadge count={props.review} tone="review" label="Ready to review" />
                  </>
                ) : null}
                {signal.pill ? (
                  <span
                    aria-hidden
                    className={cn("size-1.5 shrink-0 rounded-full", signal.pill.dotClass)}
                  />
                ) : null}
              </span>
            </span>
            <span className="truncate text-xs font-medium">{hub.shortName}</span>
          </button>
        }
      />
      <TooltipPopup side="bottom" className="max-w-64">
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">{hub.name}</span>
          {isOrchestrator ? <span>{queueLabel}</span> : null}
          <span className="text-muted-foreground">{conversationLabel}</span>
        </span>
      </TooltipPopup>
    </Tooltip>
  );
});

/** Permanent role cards above the thread list. Pinned and recent sections render unchanged below. */
export const SidebarRoleHubs = memo(function SidebarRoleHubs() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const activeRole = useLocation({
    select: (location) => {
      const match = /^\/hubs\/([^/]+)$/.exec(location.pathname);
      return match?.[1] ?? null;
    },
  });
  const { counts } = useReadyQueue();
  const openHub = useCallback(
    (role: RoleHubId) => {
      if (isMobile) setOpenMobile(false);
      void navigate({ to: "/hubs/$role", params: { role } });
    },
    [isMobile, navigate, setOpenMobile],
  );
  return (
    <nav aria-label="Role hubs" className="grid grid-cols-[1fr_1.45fr_1fr] gap-1.5 pt-2">
      {ROLE_HUB_IDS.map((role) => (
        <RoleHubCard
          key={role}
          role={role}
          active={activeRole === role}
          decide={role === "orchestrator" ? counts.decide : 0}
          review={role === "orchestrator" ? counts.review : 0}
          onOpen={openHub}
        />
      ))}
    </nav>
  );
});
