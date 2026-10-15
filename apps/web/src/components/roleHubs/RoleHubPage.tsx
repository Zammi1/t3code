import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  ClipboardCopyIcon,
  ExternalLinkIcon,
  Link2Icon,
  Link2OffIcon,
  MessageSquareTextIcon,
  PlusIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { memo, useMemo, useState, type ReactNode } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useAcknowledgeThreadWoke } from "../../hooks/useThreadActions";
import { cn } from "../../lib/utils";
import {
  READY_REASON_LABEL,
  ROLE_HUBS,
  deriveProjectDashboard,
  suggestRoleThreads,
  type ReadyItem,
  type RoleHubId,
} from "../../roleHubs/roleHubs.logic";
import { useRoleHubStore } from "../../roleHubs/roleHubStore";
import { useReadyItemDetail, useReadyQueue } from "../../roleHubs/useReadyQueue";
import { useProject, useProjects, useThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useUiStateStore } from "../../uiStateStore";
import ChatMarkdown from "../ChatMarkdown";
import {
  resolveThreadLastVisitedAt,
  resolveThreadStatusPill,
  useRetainedValue,
  useSidebarRowSubscriptionLease,
} from "../Sidebar.logic";
import { ROLE_HUB_ICONS } from "../sidebar/SidebarRoleHubs";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

function useOpenThread() {
  const navigate = useNavigate();
  return (ref: ScopedThreadRef) =>
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
}

function useEnvironmentLabels() {
  const { environments } = useEnvironments();
  return useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
}

function Freshness(props: { iso: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<time dateTime={props.iso} className="tabular-nums" />}>
        {formatRelativeTimeLabel(props.iso)}
      </TooltipTrigger>
      <TooltipPopup>{new Date(props.iso).toLocaleString()}</TooltipPopup>
    </Tooltip>
  );
}

function Section(props: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-sm font-semibold text-foreground">{props.title}</h2>
          {props.description ? (
            <p className="text-xs text-muted-foreground">{props.description}</p>
          ) : null}
        </div>
        {props.actions}
      </div>
      {props.children}
    </section>
  );
}

// ── Conversation ──────────────────────────────────────────────────────

function ThreadPicker(props: {
  threads: ReadonlyArray<EnvironmentThreadShell>;
  onPick: (thread: EnvironmentThreadShell) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const environmentLabels = useEnvironmentLabels();
  const candidates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return props.threads
      .filter(
        (thread) =>
          thread.archivedAt === null &&
          thread.deletedAt === null &&
          thread.lineage.relationshipToParent !== "subagent" &&
          (needle.length === 0 || thread.title.toLowerCase().includes(needle)),
      )
      .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 30);
  }, [props.threads, query]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button size="sm" variant="outline" />}>
        <Link2Icon />
        {props.label}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-80">
        <div className="flex flex-col gap-2">
          <Input
            autoFocus
            size="sm"
            placeholder="Search conversations..."
            aria-label="Search conversations"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ul className="flex max-h-72 flex-col overflow-y-auto" role="listbox">
            {candidates.length === 0 ? (
              <li className="px-2 py-3 text-center text-xs text-muted-foreground">
                No matching conversations.
              </li>
            ) : (
              candidates.map((thread) => (
                <li key={`${thread.environmentId}:${thread.id}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="flex w-full min-w-0 flex-col rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                    onClick={() => {
                      props.onPick(thread);
                      setOpen(false);
                    }}
                  >
                    <span className="truncate text-sm">{thread.title}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {environmentLabels.get(thread.environmentId) ?? thread.environmentId} ·{" "}
                      <Freshness iso={thread.updatedAt} />
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function ConversationSection(props: { role: RoleHubId }) {
  const hub = ROLE_HUBS[props.role];
  const threadRef = useRoleHubStore((state) => state.hubs[props.role].thread);
  const linkThread = useRoleHubStore((state) => state.linkThread);
  const thread = useThreadShell(threadRef);
  const project = useProject(
    thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null,
  );
  const localLastVisitedAt = useUiStateStore((state) =>
    threadRef ? state.threadLastVisitedAtById[scopedThreadKey(threadRef)] : undefined,
  );
  const environmentLabels = useEnvironmentLabels();
  const { threads } = useReadyQueue();
  const openThread = useOpenThread();
  const suggestions = useMemo(
    () => (threadRef === null ? suggestRoleThreads(props.role, threads).slice(0, 3) : []),
    [props.role, threadRef, threads],
  );
  const link = (picked: EnvironmentThreadShell) =>
    linkThread(props.role, scopeThreadRef(picked.environmentId, picked.id));
  const pill = thread
    ? resolveThreadStatusPill({
        thread: {
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
        },
      })
    : null;

  return (
    <Section
      title="Ongoing conversation"
      description={`The ${hub.name} thread stays on the environment where it started.`}
    >
      {threadRef !== null && thread !== null ? (
        <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <button
              type="button"
              className="truncate text-left text-sm font-medium hover:underline"
              onClick={() => openThread(threadRef)}
            >
              {thread.title}
            </button>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {pill ? (
                <span className={cn("flex items-center gap-1", pill.colorClass)}>
                  <span className={cn("size-1.5 rounded-full", pill.dotClass)} />
                  {pill.label}
                </span>
              ) : null}
              <span>{project?.title ?? "Unknown project"}</span>
              <span>· {environmentLabels.get(thread.environmentId) ?? thread.environmentId}</span>
              <span>
                · updated <Freshness iso={thread.updatedAt} />
              </span>
            </span>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button size="sm" onClick={() => openThread(threadRef)}>
              <MessageSquareTextIcon />
              Open conversation
            </Button>
            <ThreadPicker threads={threads} onPick={link} label="Change" />
            <Button size="sm" variant="ghost" onClick={() => linkThread(props.role, null)}>
              <Link2OffIcon />
              Unlink
            </Button>
          </div>
        </div>
      ) : threadRef !== null ? (
        <div className="flex flex-col gap-3 rounded-xl border border-dashed p-4 sm:flex-row sm:items-center">
          <p className="flex-1 text-sm text-muted-foreground">
            The linked conversation is not on any connected environment. Its host may be offline, or
            the thread was deleted.
          </p>
          <div className="flex shrink-0 gap-2">
            <ThreadPicker threads={threads} onPick={link} label="Choose another" />
            <Button size="sm" variant="ghost" onClick={() => linkThread(props.role, null)}>
              <Link2OffIcon />
              Unlink
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-xl border border-dashed p-4">
          <p className="text-sm text-muted-foreground">
            Link an existing thread to make it the {hub.name} conversation, or start a new one and
            link it here.
          </p>
          {suggestions.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Suggested</span>
              <div className="flex flex-wrap gap-2">
                {suggestions.map((suggestion) => (
                  <Button
                    key={`${suggestion.environmentId}:${suggestion.id}`}
                    size="sm"
                    variant="secondary"
                    className="max-w-full"
                    onClick={() => link(suggestion)}
                  >
                    <Link2Icon />
                    <span className="truncate">Use “{suggestion.title}”</span>
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <ThreadPicker threads={threads} onPick={link} label="Choose conversation" />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => openCommandPalette({ open: "new-thread-in" })}
            >
              <PlusIcon />
              New thread
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}

// ── Instructions & references ─────────────────────────────────────────

function InstructionsSection(props: { role: RoleHubId }) {
  const saved = useRoleHubStore((state) => state.hubs[props.role].instructions);
  const savedAt = useRoleHubStore((state) => state.hubs[props.role].instructionsSavedAt);
  const saveInstructions = useRoleHubStore((state) => state.saveInstructions);
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? saved;
  const dirty = draft !== null && draft !== saved;
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <Section
      title="Role instructions"
      description={
        dirty
          ? "Unsaved changes"
          : savedAt
            ? `Saved ${formatRelativeTimeLabel(savedAt)}. Copy them into the conversation when it needs a refresher.`
            : "Standing context for this role. Saved in this browser."
      }
      actions={
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={value.trim().length === 0}
            onClick={() => copyToClipboard(value)}
          >
            {isCopied ? <CheckIcon /> : <ClipboardCopyIcon />}
            {isCopied ? "Copied" : "Copy"}
          </Button>
          <Button
            size="sm"
            disabled={!dirty}
            onClick={() => {
              saveInstructions(props.role, value);
              setDraft(null);
            }}
          >
            Save
          </Button>
        </div>
      }
    >
      <Textarea
        aria-label="Role instructions"
        value={value}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={`How ${ROLE_HUBS[props.role].name} should work, what it owns, and what it must ask you first.`}
        className="min-h-28"
      />
    </Section>
  );
}

function referenceHref(value: string): string | null {
  if (/^https?:\/\//i.test(value)) return value;
  return null;
}

function ReferencesSection(props: { role: RoleHubId }) {
  const references = useRoleHubStore((state) => state.hubs[props.role].references);
  const addReference = useRoleHubStore((state) => state.addReference);
  const removeReference = useRoleHubStore((state) => state.removeReference);
  const [value, setValue] = useState("");
  const submit = () => {
    addReference(props.role, value);
    setValue("");
  };
  return (
    <Section title="References" description="Durable pointers this role keeps coming back to.">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Input
          aria-label="Add reference"
          placeholder={ROLE_HUBS[props.role].referencePlaceholder}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button type="submit" size="default" variant="outline" disabled={value.trim().length === 0}>
          <PlusIcon />
          Add
        </Button>
      </form>
      {references.length === 0 ? (
        <p className="text-xs text-muted-foreground">No references yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {references.map((reference) => {
            const href = referenceHref(reference.value);
            return (
              <li
                key={reference.id}
                className="flex max-w-full items-center gap-1 rounded-md border bg-card py-0.5 pr-0.5 pl-2 text-xs"
              >
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="flex min-w-0 items-center gap-1 hover:underline"
                  >
                    <span className="truncate">{reference.value}</span>
                    <ExternalLinkIcon className="size-3 shrink-0" />
                  </a>
                ) : (
                  <span className="truncate">{reference.value}</span>
                )}
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Remove ${reference.value}`}
                  onClick={() => removeReference(props.role, reference.id)}
                >
                  <XIcon />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

// ── Orchestrator: Ready for you ───────────────────────────────────────

const REASON_BADGE: Record<ReadyItem["reason"], "warning" | "info" | "success" | "error"> = {
  approval: "warning",
  input: "warning",
  plan: "info",
  completed: "success",
  failed: "error",
};

function PendingRequestSummary(props: { pending: PendingThreadRequests | null }) {
  const approvals = props.pending?.approvals ?? [];
  const userInputs = props.pending?.userInputs ?? [];
  if (approvals.length === 0 && userInputs.length === 0) return null;
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3">
      {approvals.map((approval) => (
        <div key={approval.requestId} className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium">
            {approval.appName ? `${approval.appName} asks for ` : "Agent asks for "}
            {approval.requestKind.replaceAll("-", " ")} approval
          </span>
          {approval.detail ? (
            <pre className="max-h-40 overflow-auto rounded-md bg-background p-2 font-mono text-xs whitespace-pre-wrap">
              {approval.detail}
            </pre>
          ) : null}
          {approval.options && approval.options.length > 0 ? (
            <span className="text-xs text-muted-foreground">
              Choices: {approval.options.map((option) => option.label).join(" · ")}
            </span>
          ) : null}
        </div>
      ))}
      {userInputs.flatMap((input) =>
        input.questions.map((question) => (
          <div key={`${input.requestId}:${question.id}`} className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">{question.header}</span>
            <span className="text-sm font-medium">{question.question}</span>
            {question.options.length > 0 ? (
              <ol className="flex flex-col gap-1">
                {question.options.map((option) => (
                  <li key={option.label} className="rounded-md border bg-background px-2 py-1.5">
                    <span className="text-xs font-medium">{option.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        )),
      )}
    </div>
  );
}

const ReadyItemCard = memo(function ReadyItemCard(props: { item: ReadyItem }) {
  const { item } = props;
  const project = useProject(scopeProjectRef(item.thread.environmentId, item.thread.projectId));
  const environmentLabels = useEnvironmentLabels();
  const openThread = useOpenThread();
  const acknowledge = useAcknowledgeThreadWoke();
  const [expanded, setExpanded] = useState(false);
  // Only cards near the viewport open their thread's detail stream.
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(false);
  const detail = useReadyItemDetail(leaseLiveStatus ? item.threadRef : null);
  const message = useRetainedValue(item.key, detail.message ?? item.message);
  const pending = useRetainedValue(item.key, detail.pending);
  const cwd = item.thread.worktreePath ?? project?.workspaceRoot;
  const isDecision = item.kind === "decide";
  return (
    <article
      ref={rowRef}
      data-testid="ready-item"
      className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <Badge variant={REASON_BADGE[item.reason]}>{READY_REASON_LABEL[item.reason]}</Badge>
        <span className="truncate">
          {project?.title ?? "Unknown project"} ·{" "}
          {environmentLabels.get(item.thread.environmentId) ?? item.thread.environmentId}
        </span>
        <span className="ml-auto">
          <Freshness iso={item.since} />
        </span>
      </header>
      <button
        type="button"
        className="truncate text-left text-sm font-medium hover:underline"
        onClick={() => openThread(item.threadRef)}
      >
        {item.thread.title}
      </button>
      {isDecision ? <PendingRequestSummary pending={pending} /> : null}
      {message ? (
        <div className="relative">
          <div
            className={cn(
              "overflow-hidden text-sm",
              !expanded && "max-h-80 [mask-image:linear-gradient(to_bottom,black_75%,transparent)]",
            )}
          >
            <ChatMarkdown
              text={message}
              cwd={cwd}
              threadRef={item.threadRef}
              environmentId={item.thread.environmentId}
            />
          </div>
          <Button
            size="xs"
            variant="ghost-muted"
            className="mt-1"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show less" : "Show full message"}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {!detail.loaded
            ? "Loading the agent's latest message..."
            : "No message from the agent to show. Open the thread for the full context."}
        </p>
      )}
      <footer className="flex flex-wrap items-center gap-2 border-t pt-3">
        {isDecision ? (
          <>
            <Button size="sm" onClick={() => openThread(item.threadRef)}>
              Open to decide
            </Button>
            <span className="text-xs text-muted-foreground">
              {item.reason === "plan"
                ? "Approve or revise the plan in the thread."
                : "Answer in the thread. Nothing is approved from here."}
            </span>
          </>
        ) : (
          <>
            <Button
              size="sm"
              onClick={() => acknowledge(item.threadRef, item.completedAt ?? item.since)}
            >
              <CheckIcon />
              Looks good
            </Button>
            <Button size="sm" variant="outline" onClick={() => openThread(item.threadRef)}>
              Request changes
            </Button>
            <span className="text-xs text-muted-foreground">
              Looks good marks it reviewed. Mark unread in the thread brings it back.
            </span>
          </>
        )}
      </footer>
    </article>
  );
});

type QueueFilter = "all" | "decide" | "review";

function ReadyQueueSection() {
  const { items, counts } = useReadyQueue();
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [limit, setLimit] = useState(12);
  const visible = items.filter((item) => filter === "all" || item.kind === filter);
  const filters: ReadonlyArray<{ id: QueueFilter; label: string; count: number }> = [
    { id: "all", label: "All", count: items.length },
    { id: "decide", label: "Decide", count: counts.decide },
    { id: "review", label: "Review", count: counts.review },
  ];
  return (
    <Section
      title="Ready for you"
      description="Live from your connected environments. Items stay until you answer, open, or mark them reviewed."
      actions={
        <div className="flex gap-1" role="tablist" aria-label="Filter ready items">
          {filters.map((entry) => (
            <Button
              key={entry.id}
              role="tab"
              aria-selected={filter === entry.id}
              size="xs"
              variant={filter === entry.id ? "secondary" : "ghost"}
              onClick={() => setFilter(entry.id)}
            >
              {entry.label}
              <span className="tabular-nums opacity-70">{entry.count}</span>
            </Button>
          ))}
        </div>
      }
    >
      {visible.length === 0 ? (
        <div className="rounded-xl border border-dashed py-4">
          <Empty size="compact">
            <EmptyHeader>
              <EmptyTitle>Nothing waiting on you</EmptyTitle>
              <EmptyDescription>
                Approvals, questions, plans, and finished work appear here as agents produce them.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {visible.slice(0, limit).map((item) => (
            <ReadyItemCard key={item.key} item={item} />
          ))}
        </div>
      )}
      {visible.length > limit ? (
        <Button size="sm" variant="ghost" onClick={() => setLimit((value) => value + 12)}>
          Show {Math.min(12, visible.length - limit)} more
        </Button>
      ) : null}
    </Section>
  );
}

function ProjectDashboardSection() {
  const { threads, items } = useReadyQueue();
  const projects = useProjects();
  const environmentLabels = useEnvironmentLabels();
  const projectTitles = useMemo(
    () =>
      new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project.title])),
    [projects],
  );
  const entries = useMemo(
    () => deriveProjectDashboard({ threads, readyItems: items }).slice(0, 9),
    [items, threads],
  );
  return (
    <Section title="Projects" description="Open threads and what needs you, per project.">
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">No open project threads.</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map((entry) => (
            <li
              key={entry.key}
              className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3"
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">
                  {projectTitles.get(entry.key) ?? "Unknown project"}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {environmentLabels.get(entry.environmentId) ?? entry.environmentId} · active{" "}
                  <Freshness iso={entry.lastActivityAt} />
                </span>
              </div>
              <dl className="grid grid-cols-4 gap-1 text-center text-xs">
                {(
                  [
                    ["Decide", entry.decide, "text-warning-foreground"],
                    ["Review", entry.review, "text-success-foreground"],
                    ["Working", entry.working, "text-info-foreground"],
                    ["Open", entry.openThreads, "text-foreground"],
                  ] as const
                ).map(([label, count, tone]) => (
                  <div key={label} className="rounded-md bg-muted/40 px-1 py-1">
                    <dt className="text-3xs text-muted-foreground">{label}</dt>
                    <dd className={cn("font-semibold tabular-nums", count > 0 && tone)}>{count}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ── Role-specific notes ───────────────────────────────────────────────

function SourceNotice(props: { role: RoleHubId }) {
  if (props.role === "orchestrator") return null;
  const text =
    props.role === "comms"
      ? "This T3 server has no messaging integration, so no people or chats load here. Ask the Comms conversation to look up WhatsApp people or chats with its own tools when you need them. Any message it drafts still needs your approval before it is sent."
      : "Ask the Mentor conversation to run research or cite library sources with its own tools. Save the @book references, sources, and topics it keeps returning to below.";
  return (
    <div className="flex items-start gap-2 rounded-xl border border-dashed p-3 text-xs text-muted-foreground">
      <SearchIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <p>{text}</p>
    </div>
  );
}

export function RoleHubPage(props: { role: RoleHubId }) {
  const hub = ROLE_HUBS[props.role];
  const Icon = ROLE_HUB_ICONS[props.role];
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <h1 className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{hub.name}</span>
          </h1>
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer width="wide">
            <p className="text-sm text-muted-foreground">{hub.summary}</p>
            <ConversationSection role={props.role} />
            {props.role === "orchestrator" ? (
              <>
                <ReadyQueueSection />
                <ProjectDashboardSection />
              </>
            ) : (
              <SourceNotice role={props.role} />
            )}
            <InstructionsSection role={props.role} />
            <ReferencesSection role={props.role} />
          </WorkspacePageContainer>
        </div>
      </div>
    </SidebarInset>
  );
}
