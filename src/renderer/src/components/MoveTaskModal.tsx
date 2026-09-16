import { useEffect, useMemo, useState } from "react";
import type { TaskView } from "@shared/types";
import { useApi, useApiMutation } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { useWorkspaces } from "@/lib/workspace";
import { Icon } from "./Icon";
import { Mark } from "./Mark";
import { Modal } from "./primitives";

/**
 * Taking a card to another board. The workspace it is in comes first, because nine times
 * in ten the card was put on the wrong project in the right area of your life. The other
 * workspaces are one click away, for the card that was captured in the wrong life
 * altogether.
 *
 * Crossing workspaces has one consequence worth saying out loud before it happens:
 * people belong to a workspace, so somebody other than you cannot come along.
 */
export function MoveTaskModal({
  open,
  onClose,
  task,
}: {
  open: boolean;
  onClose: () => void;
  task: TaskView;
}): React.JSX.Element {
  const { workspaces } = useWorkspaces();
  const [workspaceId, setWorkspaceId] = useState(task.workspaceId);
  const [chosen, setChosen] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const projects = useApi(
    "project:list",
    { workspaceId, status: "all", archived: false },
    { enabled: open },
  );
  const move = useApiMutation("task:setProject");
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    setWorkspaceId(task.workspaceId);
    setChosen(null);
    setQuery("");
  }, [open, task.workspaceId]);

  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (projects.data ?? []).filter(
      (p) =>
        p.id !== task.projectId &&
        (!needle || p.name.toLowerCase().includes(needle)),
    );
  }, [projects.data, task.projectId, query]);

  const target = options.find((p) => p.id === chosen);
  const crossing = workspaceId !== task.workspaceId;
  const leavesAssignee =
    crossing && task.assigneeName !== null && !task.assigneeIsMe;

  const submit = async (to = target): Promise<void> => {
    if (!to || move.isPending) return;
    await move.mutateAsync({ id: task.id, projectId: to.id });
    toast({
      title: `Moved to ${to.name}`,
      detail: task.title,
      icon: "arrowRight",
      to: `/projects/${to.id}/kanban`,
    });
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Move to another project"
      description={task.title}
      width="max-w-md"
      onSubmit={() => void submit()}
      footer={
        <>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            disabled={!target || move.isPending}
            onClick={() => void submit()}
          >
            Move
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {workspaces.length > 1 && (
          <div className="flex flex-wrap gap-1">
            {workspaces.map((w) => (
              <button
                key={w.id}
                type="button"
                className={`flex items-center gap-1.5 rounded-field px-2 py-1 text-[12px] transition ${
                  w.id === workspaceId
                    ? "bg-base-content/10 font-medium"
                    : "text-base-content/55 hover:bg-base-content/5 hover:text-base-content"
                }`}
                onClick={() => {
                  setWorkspaceId(w.id);
                  setChosen(null);
                }}
              >
                <Mark
                  name={w.name}
                  color={w.color}
                  icon={w.icon}
                  size={14}
                  rounded="rounded-[4px]"
                />
                {w.name}
              </button>
            ))}
          </div>
        )}

        <input
          autoFocus
          className="input input-bordered input-sm w-full"
          placeholder="Find a project…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="scroll-area hairline max-h-64 overflow-y-auto rounded-box border p-1">
          {projects.isLoading ? (
            <div className="px-2 py-6 text-center text-[12px] text-base-content/40">
              Loading…
            </div>
          ) : options.length === 0 ? (
            <div className="px-2 py-6 text-center text-[12px] text-base-content/40">
              {query.trim()
                ? "No project matches that."
                : "No other projects here."}
            </div>
          ) : (
            options.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`flex w-full items-center gap-2 rounded-field px-2 py-1.5 text-left text-[13px] transition ${
                  chosen === p.id
                    ? "bg-primary/10 font-medium"
                    : "hover:bg-base-content/5"
                }`}
                onClick={() => setChosen(p.id)}
                onDoubleClick={() => void submit(p)}
              >
                <Mark
                  name={p.name}
                  color={p.color || p.workspaceColor}
                  icon={p.icon}
                  size={18}
                />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {p.openTasks > 0 && (
                  <span className="text-[11px] tabular-nums text-base-content/35">
                    {p.openTasks}
                  </span>
                )}
                {chosen === p.id && (
                  <Icon name="check" size={13} className="text-primary" />
                )}
              </button>
            ))
          )}
        </div>

        {leavesAssignee && (
          <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-base-content/55">
            <Icon name="info" size={13} className="mt-0.5 shrink-0" />
            {task.assigneeName} belongs to {task.workspaceName}, so the card
            arrives unassigned.
          </p>
        )}
        {move.error && (
          <p className="text-[12px] text-error">{move.error.message}</p>
        )}
      </div>
    </Modal>
  );
}
