import {
  parseSourcePage,
  parseSourceEvent,
  upgradeLegacy,
  eventText,
  type SourceEvent,
  type SourceEventV2,
  type IngestionContext,
  type Receipt,
  type Checkpoint,
} from '@memo/contracts'
import { resolveObjectHead } from '@memo/domain'
import { randomUUID } from 'node:crypto'
import { bytes, digest, factIdentity, requireId } from './util'
import { iso, type Context, type PauseCode } from './context'

interface Source {
  id: string
  account_id: string
  tenant_id: string | null
  scopes: string
  active: number
  scope_epoch: number
  revision_basis: string
  pause_code: string | null
}
export interface SourceRegistration {
  id: string
  provider: string
  accountId: string
  tenantId: string | null
  revisionBasis: SourceEventV2['provenance']['revisionBasis']
}
export function source(ctx: Context, id: string): Source {
  const row = ctx.db
    .prepare('SELECT * FROM source_instances WHERE id=?')
    .get(id) as Source | undefined
  if (!row) throw new Error('UNKNOWN_SOURCE')
  return row
}
export function authorized(
  ctx: Context,
  id: string,
  scopeId?: string,
  epoch?: number,
): Source {
  const row = source(ctx, id)
  if (!row.active) throw new Error('SOURCE_DISABLED')
  if (epoch !== undefined && row.scope_epoch !== epoch)
    throw new Error('STALE_AUTHORIZATION')
  if (
    scopeId !== undefined &&
    !(JSON.parse(row.scopes) as string[]).includes(scopeId)
  )
    throw new Error('SCOPE_DENIED')
  return row
}
export function refreshHead(
  ctx: Context,
  sourceId: string,
  externalId: string,
): void {
  const rows = ctx.db
    .prepare(
      'SELECT id,envelope FROM source_events WHERE source_id=? AND external_id=? ORDER BY id',
    )
    .all(sourceId, externalId) as { id: number; envelope: string }[]
  const head = resolveObjectHead(
    rows.map((row) => {
      const e = JSON.parse(row.envelope) as SourceEventV2
      return {
        id: row.id,
        revision: e.revision,
        eventType: e.eventType,
        basis: e.provenance.revisionBasis,
        sequence: e.provenance.sequence,
        updatedAt: e.sourceUpdatedAt,
        predecessor: e.provenance.supersedesRevision,
      }
    }),
  )
  const old = ctx.db
    .prepare(
      'SELECT event_id,state,generation FROM source_object_heads WHERE source_id=? AND external_id=?',
    )
    .get(sourceId, externalId) as
    | { event_id: number | null; state: string; generation: number }
    | undefined
  if (old && old.event_id === head.eventId && old.state === head.state) return
  ctx.db
    .prepare(
      'INSERT INTO source_object_heads VALUES(?,?,?,?,?) ON CONFLICT(source_id,external_id) DO UPDATE SET event_id=excluded.event_id,state=excluded.state,generation=excluded.generation',
    )
    .run(
      sourceId,
      externalId,
      head.eventId,
      head.state,
      (old?.generation ?? 0) + 1,
    )
  ctx.db
    .prepare(
      `UPDATE evidence_links SET validity=CASE WHEN event_id=? AND ?='current' THEN 'valid' WHEN ?='tombstone' THEN 'invalid' ELSE 'needs_review' END
    WHERE event_id IN (SELECT id FROM source_events WHERE source_id=? AND external_id=?)`,
    )
    .run(head.eventId, head.state, head.state, sourceId, externalId)
  // Evidence invalidation changes a projection, never the obligation or a manual completion.
  ctx.db
    .prepare(
      `UPDATE tasks SET evidence_status='unknown' WHERE id IN (SELECT task_id FROM evidence_links WHERE validity!='valid'
    AND event_id IN (SELECT id FROM source_events WHERE source_id=? AND external_id=?))`,
    )
    .run(sourceId, externalId)
}

export function ingestion(ctx: Context) {
  const { db } = ctx
  function checkpoint(sourceId: string, streamId = 'legacy'): Checkpoint {
    const row = db
      .prepare(
        'SELECT cursor,cursor_version,scope_epoch FROM source_streams WHERE source_id=? AND id=?',
      )
      .get(sourceId, streamId) as
      | { cursor: string; cursor_version: number; scope_epoch: number }
      | undefined
    if (!row) throw new Error('UNKNOWN_STREAM')
    return {
      cursor: row.cursor,
      version: row.cursor_version,
      scopeEpoch: row.scope_epoch,
    }
  }
  function registerSource(input: string | SourceRegistration): void {
    const r =
      typeof input === 'string'
        ? {
            id: input,
            provider: 'legacy',
            accountId: 'legacy',
            tenantId: null,
            revisionBasis: 'legacy',
          }
        : input
    ;[r.id, r.provider, r.accountId].forEach(requireId)
    if (r.tenantId !== null) requireId(r.tenantId)
    if (
      ![
        'sequence',
        'predecessor',
        'source_time',
        'opaque',
        'snapshot',
        'legacy',
      ].includes(r.revisionBasis)
    )
      throw new Error('INVALID_REVISION_BASIS')
    ctx.guard(bytes(r))
    const existing = db
      .prepare(
        'SELECT provider,account_id,tenant_id,revision_basis FROM source_instances WHERE id=?',
      )
      .get(r.id) as
      | {
          provider: string
          account_id: string
          tenant_id: string | null
          revision_basis: string
        }
      | undefined
    if (existing) {
      if (
        existing.provider !== r.provider ||
        existing.account_id !== r.accountId ||
        existing.tenant_id !== r.tenantId ||
        existing.revision_basis !== r.revisionBasis
      )
        throw new Error('SOURCE_IDENTITY_CONFLICT')
      return
    }
    db.prepare(
      'INSERT INTO source_instances(id,provider,account_id,tenant_id,revision_basis) VALUES(?,?,?,?,?)',
    ).run(r.id, r.provider, r.accountId, r.tenantId, r.revisionBasis)
  }
  function invalidateSourceEvidence(id: string): void {
    db.prepare(
      "UPDATE evidence_links SET validity='needs_review' WHERE event_id IN (SELECT id FROM source_events WHERE source_id=?)",
    ).run(id)
    db.prepare(
      "UPDATE tasks SET evidence_status='unknown' WHERE id IN (SELECT task_id FROM evidence_links WHERE event_id IN (SELECT id FROM source_events WHERE source_id=?))",
    ).run(id)
  }
  function grantSource(
    id: string,
    scopes: readonly string[],
    expectedEpoch: number,
  ): number {
    if (!scopes.length || scopes.length > 100) throw new Error('INVALID_SCOPES')
    scopes.forEach(requireId)
    return db
      .transaction(() => {
        ctx.guard(bytes(scopes))
        const row = source(ctx, id)
        if (row.scope_epoch !== expectedEpoch)
          throw new Error('STALE_AUTHORIZATION')
        const epoch = row.scope_epoch + 1
        invalidateSourceEvidence(id)
        db.prepare(
          'UPDATE source_instances SET active=1,scopes=?,scope_epoch=?,pause_code=NULL WHERE id=?',
        ).run(JSON.stringify([...new Set(scopes)]), epoch, id)
        db.prepare(
          'UPDATE source_streams SET scope_epoch=? WHERE source_id=?',
        ).run(epoch, id)
        // Old work does not regain authority merely because the source was reconnected.
        db.prepare(
          "UPDATE jobs SET state='cancelled',error_code='AUTHORIZATION_CHANGED',lease_token=lease_token+1 WHERE event_id IN(SELECT id FROM source_events WHERE source_id=?) AND state NOT IN('done','dead','cancelled')",
        ).run(id)
        return epoch
      })
      .immediate()
  }
  function revokeSource(id: string): void {
    db.transaction(() => {
      source(ctx, id)
      invalidateSourceEvidence(id)
      db.prepare(
        'UPDATE source_instances SET active=0,scope_epoch=scope_epoch+1 WHERE id=?',
      ).run(id)
      db.prepare(
        "UPDATE jobs SET state='cancelled',lease_token=lease_token+1,error_code='SOURCE_DISABLED' WHERE event_id IN(SELECT id FROM source_events WHERE source_id=?) AND state NOT IN('done','dead','cancelled')",
      ).run(id)
    }).immediate()
  }
  function registerStream(sourceId: string, id: string, scopeId: string): void {
    ;[id, scopeId].forEach(requireId)
    const s = authorized(ctx, sourceId, scopeId)
    ctx.guard()
    const old = db
      .prepare('SELECT scope_id FROM source_streams WHERE source_id=? AND id=?')
      .get(sourceId, id) as { scope_id: string } | undefined
    if (old && old.scope_id !== scopeId)
      throw new Error('STREAM_SCOPE_CONFLICT')
    db.prepare(
      'INSERT INTO source_streams(source_id,id,scope_id,scope_epoch) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',
    ).run(sourceId, id, scopeId, s.scope_epoch)
  }
  function pause(sourceId: string, code: PauseCode): void {
    ctx.pauses.set('source:' + sourceId, code)
    try {
      db.prepare('UPDATE source_instances SET pause_code=? WHERE id=?').run(
        code,
        sourceId,
      )
    } catch {
      /* A full disk cannot persist its own diagnostic. */
    }
  }
  function receivePage(input: unknown, context: IngestionContext): Receipt {
    let page
    try {
      page = parseSourcePage(input)
    } catch (error) {
      throw error
    }
    if (
      context.sourceInstanceId !== page.sourceInstanceId ||
      context.scopeEpoch !== page.scopeEpoch
    )
      throw new Error('STALE_AUTHORIZATION')
    const initial = authorized(
      ctx,
      page.sourceInstanceId,
      undefined,
      page.scopeEpoch,
    )
    const oversized = page.events.some((e) => bytes(e) > ctx.limits.eventBytes)
      ? 'EVENT_TOO_LARGE'
      : bytes(page) > ctx.limits.pageBytes ||
          page.events.length > ctx.limits.pageEvents ||
          bytes(page.nextCursor) > ctx.limits.cursorBytes
        ? 'PAGE_TOO_LARGE'
        : null
    try {
      const receipt = db
        .transaction(() => {
          const s = authorized(
            ctx,
            page.sourceInstanceId,
            undefined,
            page.scopeEpoch,
          )
          const stream = db
            .prepare(
              'SELECT scope_id FROM source_streams WHERE source_id=? AND id=?',
            )
            .get(s.id, page.streamId) as { scope_id: string } | undefined
          if (!stream) throw new Error('UNKNOWN_STREAM')
          authorized(ctx, s.id, stream.scope_id, page.scopeEpoch)
          for (const e of page.events) {
            if (
              e.sourceInstanceId !== s.id ||
              e.provenance.scopeId !== stream.scope_id ||
              e.provenance.accountId !== s.account_id ||
              e.provenance.tenantId !== s.tenant_id ||
              e.provenance.revisionBasis !== s.revision_basis
            )
              throw new Error('SCOPE_DENIED')
          }
          const pageDigest = digest({
            ...page,
            events: page.events.map(factIdentity),
          })
          const old = db
            .prepare(
              'SELECT * FROM receipts WHERE source_id=? AND stream_id=? AND scope_epoch=? AND batch_id=?',
            )
            .get(s.id, page.streamId, page.scopeEpoch, page.batchId) as
            | {
                digest: string
                inserted: number
                duplicates: number
                committed_version: number
                committed_at: string
              }
            | undefined
          const result = (r: {
            inserted: number
            duplicates: number
            committed_version: number
            committed_at: string
          }): Receipt => ({
            batchId: page.batchId,
            inserted: r.inserted,
            duplicates: r.duplicates,
            committedVersion: r.committed_version,
            committedAt: r.committed_at,
            checkpoint: checkpoint(s.id, page.streamId),
          })
          if (old) {
            if (old.digest !== pageDigest)
              throw new Error('BATCH_CONTENT_CONFLICT')
            return result(old)
          }
          if (initial.pause_code) throw new Error('SOURCE_PAUSED')
          if (oversized) throw new Error(oversized)
          const before = checkpoint(s.id, page.streamId)
          if (
            before.version !== page.expectedCursorVersion ||
            before.scopeEpoch !== page.scopeEpoch
          )
            throw new Error('STALE_CHECKPOINT')
          const unique = new Map<
            string,
            { event: SourceEventV2; hash: string }
          >()
          let inserted = 0
          for (const e of page.events) {
            const key = JSON.stringify([e.externalId, e.revision]),
              hash = digest(factIdentity(e)),
              other = unique.get(key)
            if (other && other.hash !== hash)
              throw new Error('REVISION_CONTENT_CONFLICT')
            unique.set(key, { event: e, hash })
          }
          const fresh: { event: SourceEventV2; hash: string }[] = []
          for (const entry of unique.values()) {
            const oldEvent = db
              .prepare(
                'SELECT fingerprint,fingerprint_version FROM source_events WHERE source_id=? AND external_id=? AND revision=?',
              )
              .get(s.id, entry.event.externalId, entry.event.revision) as
              | { fingerprint: string; fingerprint_version: number }
              | undefined
            if (oldEvent && oldEvent.fingerprint_version !== 1)
              throw new Error('UNSUPPORTED_FINGERPRINT')
            if (oldEvent && oldEvent.fingerprint !== entry.hash)
              throw new Error('REVISION_CONTENT_CONFLICT')
            if (!oldEvent) fresh.push(entry)
          }
          const depth = ctx.depth()
          if (depth <= ctx.limits.queueLow) {
            ctx.pauses.delete('queue')
            db.prepare("DELETE FROM store_meta WHERE key='queue_paused'").run()
          }
          if (
            fresh.length &&
            (depth + fresh.length > ctx.limits.queueHigh ||
              ctx.pauses.has('queue'))
          ) {
            ctx.pauses.set('queue', 'QUEUE_LIMIT')
            throw new Error('QUEUE_LIMIT')
          }
          ctx.guard(bytes(page))
          for (const { event: e, hash } of fresh) {
            const eventId = db
              .prepare(
                'INSERT INTO source_events(source_id,external_id,revision,occurred_at,received_at,role,content,envelope,fingerprint,scope_id,scope_epoch) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
              )
              .run(
                s.id,
                e.externalId,
                e.revision,
                e.occurredAt === null
                  ? null
                  : new Date(e.occurredAt).toISOString(),
                iso(ctx),
                e.payload.kind === 'message' ? e.payload.role : null,
                eventText(e),
                JSON.stringify(e),
                hash,
                stream.scope_id,
                s.scope_epoch,
              ).lastInsertRowid
            ctx.fault('receive:event')
            db.prepare(
              'INSERT INTO jobs(event_id,operation_id,scope_epoch,created_at) VALUES(?,?,?,?)',
            ).run(
              eventId,
              'event:' + eventId + ':v1:0',
              s.scope_epoch,
              iso(ctx),
            )
            ctx.fault('receive:job')
            refreshHead(ctx, s.id, e.externalId)
            inserted++
          }
          const committedAt = iso(ctx)
          const changed = db
            .prepare(
              'UPDATE source_streams SET cursor=?,cursor_version=cursor_version+1 WHERE source_id=? AND id=? AND cursor_version=? AND scope_epoch=?',
            )
            .run(
              page.nextCursor,
              s.id,
              page.streamId,
              before.version,
              page.scopeEpoch,
            )
          if (changed.changes !== 1) throw new Error('STALE_CHECKPOINT')
          ctx.fault('receive:cursor')
          db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?,?,?,?,?)').run(
            s.id,
            page.streamId,
            page.scopeEpoch,
            page.batchId,
            pageDigest,
            inserted,
            page.events.length - inserted,
            before.version + 1,
            committedAt,
          )
          pruneReceipts(s.id, page.streamId, 1000)
          ctx.fault('receive:receipt')
          return result({
            inserted,
            duplicates: page.events.length - inserted,
            committed_version: before.version + 1,
            committed_at: committedAt,
          })
        })
        .immediate()
      ctx.fault('receive:after_commit')
      return receipt
    } catch (error) {
      const code = (error as Error).message
      if (code === 'QUEUE_LIMIT') {
        try {
          db.prepare(
            "INSERT OR REPLACE INTO store_meta VALUES('queue_paused','1')",
          ).run()
        } catch {}
      }
      if ((error as { code?: string }).code === 'SQLITE_FULL')
        ctx.pauses.set('storage', 'STORAGE_ERROR')
      if (
        code === 'REVISION_CONTENT_CONFLICT' ||
        code === 'EVENT_TOO_LARGE' ||
        code === 'PAGE_TOO_LARGE'
      )
        pause(page.sourceInstanceId, code)
      throw error
    }
  }
  function pruneReceipts(
    sourceId: string,
    streamId: string,
    keep = 1000,
  ): void {
    if (!Number.isInteger(keep) || keep < 1 || keep > 10000)
      throw new Error('INVALID_RETENTION')
    db.prepare(
      `DELETE FROM receipts WHERE source_id=? AND stream_id=? AND rowid NOT IN
      (SELECT rowid FROM receipts WHERE source_id=? AND stream_id=? ORDER BY committed_at DESC,committed_version DESC LIMIT ?)`,
    ).run(sourceId, streamId, sourceId, streamId, keep)
  }
  function receive(event: SourceEvent, cursor: string): { inserted: boolean } {
    const value = parseSourceEvent(event)
    const s = authorized(ctx, value.sourceInstanceId, 'legacy')
    registerStream(s.id, 'legacy', 'legacy')
    const cp = checkpoint(s.id)
    const reply = receivePage(
      {
        sourceInstanceId: s.id,
        streamId: 'legacy',
        scopeEpoch: s.scope_epoch,
        batchId: randomUUID(),
        expectedCursorVersion: cp.version,
        nextCursor: cursor,
        events: [upgradeLegacy(value)],
      },
      { sourceInstanceId: s.id, scopeEpoch: s.scope_epoch },
    )
    return { inserted: reply.inserted === 1 }
  }
  return {
    registerSource,
    grantSource,
    revokeSource,
    registerStream,
    checkpoint,
    receivePage,
    receive,
    pruneReceipts,
    resumeSource(id: string) {
      authorized(ctx, id)
      ctx.guard()
      db.prepare('UPDATE source_instances SET pause_code=NULL WHERE id=?').run(
        id,
      )
      ctx.pauses.delete('source:' + id)
      ctx.pauses.delete('storage')
      db.prepare(
        "UPDATE jobs SET state='retry_wait',next_run=0,error_code=NULL WHERE state='paused' AND error_code IN ('CLOCK_CHANGED','SOURCE_PAUSED','DISK_LIMIT','DISK_UNAVAILABLE') AND event_id IN (SELECT id FROM source_events WHERE source_id=?)",
      ).run(id)
    },
    cursor(id: string) {
      try {
        return checkpoint(id).cursor
      } catch {
        return undefined
      }
    },
    event(id: number): SourceEventV2 {
      const row = db
        .prepare('SELECT envelope FROM source_events WHERE id=?')
        .get(id) as { envelope: string } | undefined
      if (!row) throw new Error('UNKNOWN_EVENT')
      return JSON.parse(row.envelope) as SourceEventV2
    },
    eventGeneration(id: number): number {
      const r = db
        .prepare(
          'SELECT h.generation FROM source_events e JOIN source_object_heads h ON h.source_id=e.source_id AND h.external_id=e.external_id WHERE e.id=?',
        )
        .get(id) as { generation: number } | undefined
      if (!r) throw new Error('UNKNOWN_EVENT')
      return r.generation
    },
  }
}
