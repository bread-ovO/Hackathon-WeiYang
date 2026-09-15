import type { WorkspaceTask } from '@memo/contracts'

/** Remember the current query's rows so navigation is never mistaken for ingestion. */
export function createTaskArrivalTracker() {
  let scope: string | null = null
  let known = new Map<string, WorkspaceTask['admission']>()
  return (tasks: WorkspaceTask[], nextScope: string, append = false) => {
    const arrivals =
      scope === nextScope && !append
        ? tasks
            .filter(
              (task) =>
                !known.has(task.id) ||
                (known.get(task.id) === 'candidate' &&
                  task.admission === 'accepted'),
            )
            .map((task) => task.id)
        : []
    if (scope !== nextScope) known = new Map()
    for (const task of tasks) known.set(task.id, task.admission)
    scope = nextScope
    return arrivals
  }
}
