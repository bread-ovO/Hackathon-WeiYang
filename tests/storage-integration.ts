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
} finally {rmSync(folder,{recursive:true,force:true})}
