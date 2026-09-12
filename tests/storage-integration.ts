import { createEventReceiver } from '../packages/storage/src/receive'
import {openStore} from '@memo/storage'
import {receiveEvent} from '@memo/application'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
const folder=mkdtempSync(join(tmpdir(),'memo-storage-'));const path=join(folder,'test.sqlite')
try {
 let store=openStore(path);store.registerSource('sample')
 const event={schemaVersion:1,sourceInstanceId:'sample',externalId:'m1',revision:'1',occurredAt:'2026-09-12T09:00:00Z',role:'user',text:'测试承诺'}
 for(let i=0;i<10;i++)receiveEvent(store,event,'page1')
 assert.equal(store.health().eventCount,1);assert.equal(store.health().jobCount,1);assert.equal(store.cursor('sample'),'page1')
 // Same revision is immutable through the base ingress, not just source/plugin adapters.
 for (const patch of [{text:'修订内容却没有换revision'}, {role:'assistant'}, {occurredAt:'2026-09-12T10:00:00Z'}]) {
   assert.throws(()=>receiveEvent(store,{...event,...patch},'must-not-advance'), /SOURCE_REVISION_CONFLICT/)
   assert.equal(store.health().eventCount,1);assert.equal(store.health().jobCount,1)
   assert.equal(store.cursor('sample'),'page1')
 }

 // Fail between event insertion and cursor update. SQLite must roll back all effects.
 const raw=new Database(path);raw.exec("CREATE TRIGGER fail_job BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'SIMULATED_DISK_FAILURE'); END;")
 assert.throws(()=>receiveEvent(store,{...event,revision:'2'},'page2'))
 assert.equal(store.health().eventCount,1);assert.equal(store.cursor('sample'),'page1')
 raw.exec('DROP TRIGGER fail_job');raw.close()
 receiveEvent(store,{...event,revision:'2'},'page2');store.close()
 store=openStore(path);assert.equal(store.health().eventCount,2);assert.equal(store.health().jobCount,2);assert.equal(store.cursor('sample'),'page2')
 assert.throws(()=>receiveEvent(store,{...event,sourceInstanceId:'unauthorized'},''),'Unknown source rejected')
 console.log('Storage integration passed:',store.health());store.close()
 const future=new Database(path);future.pragma('user_version = 99');future.close()
 assert.throws(()=>openStore(path),/DATABASE_TOO_NEW/)
 // Independent synthetic database: source namespace, restart replay and callback rollback.
 const replayPath=join(folder,'replay.sqlite')
 let replay=openStore(replayPath);replay.registerSource('sample');replay.registerSource('other')
 const row={schemaVersion:1 as const,sourceInstanceId:'sample',externalId:'m1',revision:'1',occurredAt:'2026-09-12T09:00:00Z',role:'user' as const,text:'虚构承诺'}
 for(let i=0;i<10;i++)replay.receive(row,`page-${i}`)
 assert.equal(replay.health().eventCount,1);assert.equal(replay.health().jobCount,1)
 replay.receive({...row,revision:'2',text:'虚构编辑'},'edited')
 replay.receive({...row,sourceInstanceId:'other'},'other-page')
 assert.equal(replay.health().eventCount,3);assert.equal(replay.health().jobCount,3)
 replay.close();replay=openStore(replayPath)
 assert.deepEqual(replay.receive({...row,revision:'2',text:'虚构编辑'},'replayed'),{inserted:false})
 assert.equal(replay.health().eventCount,3);assert.equal(replay.health().jobCount,3)
 assert.throws(()=>replay.receive({...row,revision:'2',text:'冲突'},'bad'),/SOURCE_REVISION_CONFLICT/)
 assert.equal(replay.cursor('sample'),'replayed')
 assert.throws(()=>replay.receive({...row,role:'unknown'} as never,'bad'),/INVALID_SOURCE_EVENT/)
 assert.throws(()=>replay.receive(row,'x'.repeat(16385)),/CURSOR_TOO_LARGE/)
 const audit=new Database(replayPath);audit.pragma('foreign_keys = ON')
 audit.exec('CREATE TABLE receive_audit(event_id INTEGER PRIMARY KEY,received_at TEXT NOT NULL)')
 const failing=createEventReceiver(audit,(_event,id,receivedAt)=>{
   audit.prepare('INSERT INTO receive_audit VALUES(?,?)').run(id,receivedAt)
   throw Error('CONTEXT_FAILURE')
 })
 assert.throws(()=>failing({...row,revision:'3'},'bad'),/CONTEXT_FAILURE/)
 assert.equal(replay.health().eventCount,3);assert.equal(replay.health().jobCount,3)
 assert.equal(replay.cursor('sample'),'replayed')
 assert.equal((audit.prepare('SELECT COUNT(*) AS n FROM receive_audit').get() as {n:number}).n,0)
 let callbackCount=0
 const receiving=createEventReceiver(audit,(_event,id,receivedAt)=>{
   callbackCount++
   audit.prepare('INSERT INTO receive_audit VALUES(?,?)').run(id,receivedAt)
 })
 for(let i=0;i<10;i++)receiving({...row,revision:'3'},'latest')
 assert.equal(callbackCount,1)
 assert.equal((audit.prepare('SELECT COUNT(*) AS n FROM receive_audit a JOIN source_events e ON e.id=a.event_id AND e.received_at=a.received_at').get() as {n:number}).n,1)
 assert.equal(replay.health().eventCount,4);assert.equal(replay.health().jobCount,4)
 audit.close();replay.close()

} finally {rmSync(folder,{recursive:true,force:true})}
