import { openStore, type Store, type StoreOptions } from '@memo/storage'
import {
  parseEventV2,
  type SourceEventV2,
  type SourcePage,
  type TaskCommand,
  type DecisionProposal,
  type Lease,
} from '@memo/contracts'
export const NOW = Date.parse('2026-09-12T09:00:00Z')
export const probe = () => ({
  usedBytes: 1024 * 1024,
  availableBytes: 1024 * 1024 * 1024,
})
export function setup(path: string, options: StoreOptions = {}): Store {
  const s = openStore(path, { now: () => NOW, probe, ...options })
  s.registerSource({
    id: 'source',
    provider: 'fixture',
    accountId: 'account',
    tenantId: 'tenant',
    revisionBasis: 'sequence',
  })
  s.grantSource('source', ['scope'], 1)
  s.registerStream('source', 'main', 'scope')
  s.createProject('project', '项目')
  return s
}
export function event(
  revision = 1,
  externalId = 'message',
  text = '提交修复 PR 并反馈链接',
): SourceEventV2 {
  return parseEventV2({
    schemaVersion: 2,
    sourceInstanceId: 'source',
    externalId,
    revision: String(revision),
    eventType: revision === 1 ? 'created' : 'updated',
    occurredAt: new Date(NOW + revision * 1000).toISOString(),
    sourceUpdatedAt: new Date(NOW + revision * 1000).toISOString(),
    timeBasis: {
      raw: new Date(NOW + revision * 1000).toISOString(),
      timeZone: 'Asia/Shanghai',
      kind: 'explicit_offset',
    },
    payload: { kind: 'message', role: 'user', text },
    provenance: {
      adapterId: 'fixture',
      adapterVersion: '1',
      scopeId: 'scope',
      accountId: 'account',
      tenantId: 'tenant',
      resourceId: externalId,
      author: { namespace: 'tenant:account', id: 'user' },
      revisionBasis: 'sequence',
      sequence: revision,
      supersedesRevision: null,
      coverage: 'revisioned',
    },
  })
}
export function page(
  s: Store,
  events: SourceEventV2[],
  batchId = 'batch',
): SourcePage {
  const cp = s.checkpoint('source', 'main')
  return {
    sourceInstanceId: 'source',
    streamId: 'main',
    scopeEpoch: cp.scopeEpoch,
    batchId,
    expectedCursorVersion: cp.version,
    nextCursor: 'cursor:' + batchId,
    events,
  }
}
export function receive(s: Store, events: SourceEventV2[], batchId = 'batch') {
  const p = page(s, events, batchId)
  return s.receivePage(p, {
    sourceInstanceId: 'source',
    scopeEpoch: p.scopeEpoch,
  })
}
export function proposal(
  s: Store,
  commands: TaskCommand[],
  eventIds: number[] = [],
): DecisionProposal {
  return {
    commands,
    expected: [...new Set(commands.map((c) => c.taskId))].map((id) => {
      const t = s.getTask(id)
      return {
        taskId: id,
        version: t?.version ?? 0,
        criteriaVersion: t?.criteriaVersion ?? 0,
        manualVersion: t?.manualVersion ?? 0,
      }
    }),
    inputs: eventIds.map((id) => ({
      eventId: id,
      generation: s.eventGeneration(id),
      scopeEpoch: s.checkpoint('source', 'main').scopeEpoch,
    })),
    mappings: [],
    reason: '隔离验收操作',
    policyVersion: 'v1',
  }
}
export function createCommands(
  id = 'task',
  title = '修复登录并反馈 PR',
  projectId = 'project',
): TaskCommand[] {
  return [
    {
      kind: 'create',
      taskId: id,
      title,
      projectId,
      sourceId: 'source',
      scopeId: 'scope',
    },
    { kind: 'set_intake', taskId: id, intake: 'accepted' },
  ]
}
export function jobProposal(
  s: Store,
  lease: Lease,
  commands: TaskCommand[] = createCommands(),
): DecisionProposal {
  return proposal(s, commands, [lease.eventId])
}
