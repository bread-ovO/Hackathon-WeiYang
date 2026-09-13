import { identityKey } from '@memo/domain'
import { type Context } from './context'
import { authorized, source } from './ingestion'
import { digest, requireId } from './util'
export function identityRepository(ctx: Context) {
  const { db } = ctx
  return {
    createProject(id: string, name: string) {
      requireId(id)
      requireId(name)
      ctx.guard()
      db.prepare('INSERT INTO projects VALUES(?,?)').run(id, name)
    },
    registerIdentity(
      sourceId: string,
      namespace: string,
      externalId: string,
      displayName: string,
    ): string {
      ;[namespace, externalId, displayName].forEach(requireId)
      authorized(ctx, sourceId)
      const s = source(ctx, sourceId)
      const provider = (
        db
          .prepare('SELECT provider FROM source_instances WHERE id=?')
          .get(sourceId) as { provider: string }
      ).provider
      const id = digest([
        sourceId,
        identityKey(provider, s.tenant_id, s.account_id, namespace, externalId),
      ])
      ctx.guard()
      db.prepare(
        'INSERT INTO identities VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name',
      ).run(id, sourceId, namespace, externalId, displayName)
      return id
    },
    confirmMapping(
      id: string,
      leftId: string,
      rightId: string,
      projectId: string,
      actor: string,
    ): number {
      ;[id, projectId, actor].forEach(requireId)
      if (actor === 'automatic') throw new Error('MANUAL_ACTION_REQUIRED')
      return db
        .transaction(() => {
          ctx.guard()
          for (const identity of [leftId, rightId]) {
            const row = db
              .prepare('SELECT source_id FROM identities WHERE id=?')
              .get(identity) as { source_id: string } | undefined
            if (!row) throw new Error('UNKNOWN_IDENTITY')
            authorized(ctx, row.source_id)
          }
          const current = db
            .prepare('SELECT * FROM identity_mappings WHERE id=?')
            .get(id) as { version: number } | undefined
          const version = (current?.version ?? 0) + 1
          db.prepare(
            'INSERT INTO identity_mappings VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET left_id=excluded.left_id,right_id=excluded.right_id,project_id=excluded.project_id,version=excluded.version,active=1,actor=excluded.actor',
          ).run(id, leftId, rightId, projectId, version, 1, actor)
          db.prepare('INSERT INTO mapping_revisions VALUES(?,?,?)').run(
            id,
            version,
            JSON.stringify({ leftId, rightId, projectId, active: true, actor }),
          )
          return version
        })
        .immediate()
    },
    revokeMapping(id: string, expectedVersion: number, actor: string) {
      requireId(actor)
      ctx.guard()
      db.transaction(() => {
        const result = db
          .prepare(
            'UPDATE identity_mappings SET active=0,version=version+1,actor=? WHERE id=? AND version=?',
          )
          .run(actor, id, expectedVersion)
        if (result.changes !== 1) throw new Error('MAPPING_VERSION_CONFLICT')
        db.prepare('INSERT INTO mapping_revisions VALUES(?,?,?)').run(
          id,
          expectedVersion + 1,
          JSON.stringify({ active: false, actor }),
        )
      }).immediate()
    },
  }
}
