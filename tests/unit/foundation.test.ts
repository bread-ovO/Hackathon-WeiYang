import {describe,it,expect} from 'vitest'
import {parseSourceEvent,parseCoreRequest} from '@memo/contracts'
import {archiveTask,assertExpectedVersion,type Task} from '@memo/domain'
import {receiveEvent} from '@memo/application'
import {isTrustedPage} from '../../apps/desktop/src/main/security'
const sample={schemaVersion:1,sourceInstanceId:'test',externalId:'m1',revision:'1',occurredAt:'2026-09-12T09:00:00Z',role:'user',text:'提交 PR'}
describe('public boundaries',()=>{
 it('preserves roles and rejects unexpected instructions as fields',()=>{
  expect(parseSourceEvent({...sample,role:'assistant'}).role).toBe('assistant')
  expect(()=>parseSourceEvent({...sample,execute:'rm -rf'})).toThrow('INVALID_SOURCE_EVENT')
  expect(()=>parseSourceEvent({...sample,role:'owner'})).toThrow()
 })
 it('requires explicit time zone and bounded input',()=>{
  expect(()=>parseSourceEvent({...sample,occurredAt:'Friday'})).toThrow()
  expect(()=>parseSourceEvent({...sample,occurredAt:'2026-02-30T09:00:00Z'})).toThrow()
  expect(()=>parseSourceEvent({...sample,occurredAt:'2026-09-12T09:00:00'})).toThrow()
  expect(()=>parseSourceEvent({...sample,text:'x'.repeat(65537)})).toThrow()
 })
 it('does not expose arbitrary IPC methods or payloads',()=>{
  expect(parseCoreRequest({method:'health'})).toEqual({method:'health'})
  expect(()=>parseCoreRequest({method:'readFile',path:'/etc/passwd'})).toThrow()
  expect(()=>parseCoreRequest({method:'health',path:'/etc/passwd'})).toThrow()
 })
 it('does not persist invalid input',()=>{
  let writes=0;const store={receive:()=>{writes++;return {inserted:true}}}
  expect(()=>receiveEvent(store,{...sample,schemaVersion:99},'')).toThrow();expect(writes).toBe(0)
 })
})
describe('domain invariants',()=>{
 const task:Task={id:'t1',title:'反馈链接',status:'waiting',evidenceStatus:'partial',version:2,archivedAt:null}
 it('archiving never completes an obligation or mutates input',()=>{
  expect(archiveTask(task,'2026-09-12T09:00:00Z')).toMatchObject({status:'waiting',evidenceStatus:'partial',version:3})
  expect(task.archivedAt).toBeNull()
 })
 it('rejects stale automatic decisions after a manual update',()=>{
  expect(()=>assertExpectedVersion(3,2)).toThrow('VERSION_CONFLICT')
  expect(()=>assertExpectedVersion(3,3)).not.toThrow()
 })
})
describe('renderer trust',()=>{
 it('accepts only the entry page, not foreign origins or other local pages',()=>{
  expect(isTrustedPage('memo://app/index.html','memo://app/index.html')).toBe(true)
  expect(isTrustedPage('https://evil.test/index.html','memo://app/index.html')).toBe(false)
  expect(isTrustedPage('memo://evil/index.html','memo://app/index.html')).toBe(false)
  expect(isTrustedPage('memo://app/other.html','memo://app/index.html')).toBe(false)
  expect(isTrustedPage('http://localhost:5174/','http://localhost:5173/')).toBe(false)
 })
})
