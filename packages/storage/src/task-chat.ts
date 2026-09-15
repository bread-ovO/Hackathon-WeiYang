import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import {
  parseChatOutput,
  type ChatRun,
  type ChatTask,
  type ChatOutput,
} from '@memo/contracts'
import { createTaskModel, type StoredTask, type TaskPatch } from './task-model'
export function migrateTaskChat(db: Database.Database) {
  db.transaction(() =>
    db.exec(`
CREATE TABLE agent_chat_runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),payload TEXT NOT NULL);
CREATE TABLE agent_task_trash(task_id TEXT PRIMARY KEY REFERENCES tasks(id),project_id TEXT NOT NULL REFERENCES projects(id),previous TEXT NOT NULL);
PRAGMA user_version=24;
`),
  )()
}
export function createTaskChat(db: Database.Database) {
  const tasks = createTaskModel(db)
  const read = (id: string, projectId: string): ChatRun => {
    const row = db
      .prepare(
        'SELECT payload FROM agent_chat_runs WHERE id=? AND project_id=?',
      )
      .get(id, projectId) as { payload: string } | undefined
    if (!row) throw Error('NOT_FOUND')
    return JSON.parse(row.payload)
  }
  const write = (run: ChatRun) => {
    db.prepare(
      'UPDATE agent_chat_runs SET payload=? WHERE id=? AND project_id=?',
    ).run(JSON.stringify(run), run.id, run.projectId)
  }
  const asTask = (t: StoredTask): ChatTask => ({
    id: t.id,
    title: t.title,
    status: t.status,
    version: t.version,
    criteriaVersion: t.criteriaVersion,
    manualVersion: t.manualVersion,
    dueAt: t.dueAt,
    owner: t.owner,
    deleted: !!db
      .prepare('SELECT 1 FROM agent_task_trash WHERE task_id=?')
      .get(t.id),
  })
  const list = (projectId: string): ChatRun[] =>
    (
      db
        .prepare(
          'SELECT payload FROM agent_chat_runs WHERE project_id=? ORDER BY rowid DESC LIMIT 30',
        )
        .all(projectId) as { payload: string }[]
    )
      .reverse()
      .map((r) => JSON.parse(r.payload))
  return {
    read,
    list,
    recover() {
      for (const row of db
        .prepare('SELECT payload FROM agent_chat_runs')
        .all() as { payload: string }[]) {
        const r: ChatRun = JSON.parse(row.payload)
        if (r.state === 'running') {
          r.state = 'failed'
          r.error = 'CHAT_INTERRUPTED'
          r.trace.push('应用重启，运行已中断，可重新发送')
          write(r)
        }
      }
    },
    start(projectId: string, prompt: string) {
      if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId))
        throw Error('NOT_FOUND')
      const run: ChatRun = {
        id: randomUUID(),
        projectId,
        prompt,
        state: 'running',
        reply: '',
        actions: [],
        tasks: [],
        trace: ['协调器：准备项目上下文'],
        error: null,
        model: '',
        createdAt: new Date().toISOString(),
      }
      db.prepare('INSERT INTO agent_chat_runs VALUES(?,?,?)').run(
        run.id,
        projectId,
        JSON.stringify(run),
      )
      return run
    },
    trace(id: string, projectId: string, step: string) {
      const r = read(id, projectId)
      if (r.state === 'running') {
        r.trace.push(step)
        write(r)
      }
    },
    search(projectId: string, query: string) {
      const rows = db
        .prepare(
          `SELECT id FROM tasks WHERE project_id=? AND (?='' OR instr(lower(title),lower(?))>0 OR id=?) ORDER BY id LIMIT 100`,
        )
        .all(projectId, query, query, query) as { id: string }[]
      const matches = rows.map((r) => asTask(tasks.get(projectId, r.id)!))
      return {
        items: matches,
        totalIsLimited: true,
        note: '在当前项目全部任务中按标题搜索，最多返回100项；deleted=true在回收站，不能当作活跃任务。',
      }
    },
    get(projectId: string, id: string) {
      const t = tasks.get(projectId, id)
      if (!t) throw Error('NOT_FOUND')
      return asTask(t)
    },
    finish(
      id: string,
      projectId: string,
      output: ChatOutput,
      observed: ChatTask[],
      model: string,
    ) {
      const r = read(id, projectId)
      if (r.state !== 'running') throw Error('CHAT_CANCELLED')
      const safe = parseChatOutput(JSON.stringify(output))
      for (const a of safe.actions) {
        if (a.kind !== 'create' && !observed.some((t) => t.id === a.taskId))
          throw Error('CHAT_UNKNOWN_TASK')
        if (
          a.kind === 'update' &&
          a.title === null &&
          a.status === null &&
          a.dueAt === null &&
          a.owner === null
        )
          throw Error('CHAT_INVALID_OUTPUT')
      }
      if (
        new Set(
          safe.actions.filter((a) => a.kind !== 'create').map((a) => a.taskId),
        ).size !== safe.actions.filter((a) => a.kind !== 'create').length
      )
        throw Error('CHAT_INVALID_OUTPUT')
      r.state = 'ready'
      r.reply = safe.message
      r.actions = safe.actions
      r.tasks = observed
      r.model = model
      r.trace.push(safe.actions.length ? '校验器：变更待确认' : '已完成查询')
      write(r)
    },
    finishDraft(id: string, projectId: string, draft: import('@memo/contracts').ChatDraft) {
      const r = read(id, projectId)
      if (r.state !== 'running') throw Error('CHAT_CANCELLED')
      r.state = 'ready'
      r.reply = '已按事项记录生成草稿，可编辑后复制。'
      r.draft = draft
      r.trace.push('本机记录摘录；未调用模型，未向外发送')
      write(r)
    },
    fail(id: string, projectId: string, error: string) {
      const r = read(id, projectId)
      if (r.state === 'running') {
        r.state = 'failed'
        r.error = error
        write(r)
      }
    },
    cancel(id: string, projectId: string, reject = false) {
      const r = read(id, projectId)
      if (r.state === 'running' || r.state === 'ready') {
        r.state = reject ? 'rejected' : 'cancelled'
        write(r)
      }
    },
    confirm: db.transaction((id: string, projectId: string) => {
      const r = read(id, projectId)
      if (r.state === 'applied') return
      if (r.state !== 'ready' || !r.actions.length)
        throw Error('CHAT_NOT_READY')
      const safe = parseChatOutput(
        JSON.stringify({
          message: r.reply,
          tool: 'propose_changes',
          query: '',
          taskId: '',
          actions: r.actions,
        }),
      )
      const by = { actorId: 'local-user', reason: `用户确认AI聊天建议 ${id}` }
      for (const a of safe.actions) {
        if (a.kind === 'create') {
          const t = tasks.create(
            {
              id: randomUUID(),
              projectId,
              title: a.title!,
              admission: 'accepted',
            },
            by,
          )
          if (a.status || a.dueAt || a.owner)
            tasks.update(
              {
                projectId,
                taskId: t.id,
                expectedVersion: t.version,
                expectedCriteriaVersion: t.criteriaVersion,
                expectedManualVersion: t.manualVersion,
              },
              {
                ...(a.status ? { status: a.status } : {}),
                ...(a.dueAt ? { dueAt: a.dueAt } : {}),
                ...(a.owner ? { owner: a.owner } : {}),
              },
              by,
            )
        } else {
          const baseline = r.tasks.find((t) => t.id === a.taskId)
          if (!baseline) throw Error('CHAT_UNKNOWN_TASK')
          const current = tasks.get(projectId, a.taskId)
          if (
            !current ||
            current.version !== baseline.version ||
            current.manualVersion !== baseline.manualVersion ||
            current.criteriaVersion !== baseline.criteriaVersion
          )
            throw Error('VERSION_CONFLICT')
          const trash = db
            .prepare(
              'SELECT previous FROM agent_task_trash WHERE task_id=? AND project_id=?',
            )
            .get(a.taskId, projectId) as { previous: string } | undefined
          const expected = {
            projectId,
            taskId: a.taskId,
            expectedVersion: baseline.version,
            expectedCriteriaVersion: baseline.criteriaVersion,
            expectedManualVersion: baseline.manualVersion,
          }
          if (a.kind === 'restore') {
            if (!trash) throw Error('CHAT_NOT_DELETED')
            const previous = JSON.parse(trash.previous) as StoredTask
            db.prepare('DELETE FROM agent_task_trash WHERE task_id=?').run(
              a.taskId,
            )
            tasks.update(
              expected,
              {
                archived: !!previous.archivedAt,
                admission: previous.admission,
              },
              by,
            )
          } else {
            if (trash) throw Error('CHAT_TASK_DELETED')
            const patch: TaskPatch =
              a.kind === 'delete'
                ? { archived: true, admission: 'ignored' }
                : {
                    ...(a.title !== null ? { title: a.title } : {}),
                    ...(a.status !== null ? { status: a.status } : {}),
                    ...(a.dueAt !== null ? { dueAt: a.dueAt || null } : {}),
                    ...(a.owner !== null ? { owner: a.owner || null } : {}),
                  }
            tasks.update(expected, patch, by)
            if (a.kind === 'delete')
              db.prepare('INSERT INTO agent_task_trash VALUES(?,?,?)').run(
                a.taskId,
                projectId,
                JSON.stringify(current),
              )
          }
        }
      }
      r.state = 'applied'
      r.trace.push('用户确认：变更已原子提交')
      write(r)
    }),
  }
}
