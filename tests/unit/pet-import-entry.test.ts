import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findModelEntries, ImportSession, importSessionTtlMs, discoveryLimits } from '../../apps/desktop/src/main/pet/import-session'
import { createPetImportFlow } from '../../apps/desktop/src/main/pet/import-flow'
import { parseCoreRequest, parseHostRequest } from '@memo/contracts'
let root:string
beforeEach(async()=>{root=await realpath(await mkdtemp(path.join(tmpdir(),'bugu-pet-entry-')))})
afterEach(async()=>{await rm(root,{recursive:true,force:true})})
describe('worker-only bounded model discovery',()=>{
  it('finds sorted nested entries and detects editor projects',async()=>{
    await mkdir(path.join(root,'nested'));await writeFile(path.join(root,'b.model3.json'),'{}');await writeFile(path.join(root,'nested/a.model3.json'),'{}');await writeFile(path.join(root,'project.cmo3'),'x')
    expect(await findModelEntries(root)).toEqual({entries:['b.model3.json','nested/a.model3.json'],cmo3Found:true})
  })
  it('reports depth limit rather than false no-model',async()=>{
    let directory=root
    for(let i=0;i<=discoveryLimits.maxDepth;i++){directory=path.join(directory,'nested');await mkdir(directory)}
    await expect(findModelEntries(root)).rejects.toMatchObject({code:'storage-limit'})
  })
  it('bounds directory count independently of depth',async()=>{
    await Promise.all(Array.from({length:discoveryLimits.maxDirectories},(_,i)=>mkdir(path.join(root,`dir-${i}`))))
    await expect(findModelEntries(root)).rejects.toMatchObject({code:'storage-limit'})
  })
  it('bounds candidate count',async()=>{
    await Promise.all(Array.from({length:discoveryLimits.maxCandidates+1},(_,i)=>writeFile(path.join(root,`${i}.model3.json`),'{}')))
    await expect(findModelEntries(root)).rejects.toMatchObject({code:'storage-limit'})
  })
  it('bounds total entries even when there are no candidates',async()=>{
    for(let i=0;i<=discoveryLimits.maxEntries;i++)await writeFile(path.join(root,`${i}.txt`),'')
    await expect(findModelEntries(root)).rejects.toMatchObject({code:'storage-limit'})
  })
  it.skipIf(process.platform==='win32')('skips linked files and directories without listing external entries',async()=>{
    const outside=await realpath(await mkdtemp(path.join(tmpdir(),'bugu-pet-outside-')))
    try{
      await writeFile(path.join(outside,'private.model3.json'),'{}');await symlink(outside,path.join(root,'external'));await symlink(path.join(outside,'private.model3.json'),path.join(root,'linked.model3.json'))
      expect(await findModelEntries(root)).toEqual({entries:[],cmo3Found:false})
      await expect(findModelEntries(path.join(root,'external'))).rejects.toMatchObject({code:'source-changed'})
    }finally{await rm(outside,{recursive:true,force:true})}
  })
})
describe('single-use expiring selection capability',()=>{
  it('binds token to directory and discovered entry, detaching exposed arrays',()=>{
    const session=new ImportSession();const first=session.choose('/models/a',{entries:['pet.model3.json'],cmo3Found:false})
    expect(first.status).toBe('ready');if(first.status==='no-model')throw new Error()
    first.entries.push('escape.model3.json')
    expect(session.consume(first.sessionId,'escape.model3.json')).toBeNull()
    const second=session.choose('/models/b',{entries:['pet.model3.json'],cmo3Found:false});if(second.status==='no-model')throw new Error()
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(session.consume(first.sessionId,'pet.model3.json')).toBeNull()
    expect(session.consume(second.sessionId,'../pet.model3.json')).toBeNull()
    expect(session.consume(second.sessionId,'pet.model3.json')).toBe('/models/b')
    expect(session.consume(second.sessionId,'pet.model3.json')).toBeNull()
  })
  it.each([importSessionTtlMs,-1])('expires after elapsed or backward time %s',time=>{
    let clock=0;const session=new ImportSession(()=>clock);const view=session.choose(root,{entries:['pet.model3.json'],cmo3Found:false});if(view.status==='no-model')throw new Error()
    clock=time;expect(session.consume(view.sessionId,'pet.model3.json')).toBeNull();expect(session.pending()).toBe(false)
  })
})
const importedModel={id:'a'.repeat(64),entry:'pet.model3.json',importedAt:'2026-09-13T00:00:00.000Z',totalBytes:42}
function fixture(){
  const picker=vi.fn().mockResolvedValue(root)
  const worker={request:vi.fn().mockImplementation(async(method:string)=>({ok:true,data:method==='discover'?{entries:['pet.model3.json'],cmo3Found:false}:method==='import'?{status:'imported',model:importedModel}:{currentModelId:null,models:[importedModel]}}))}
  return {picker,worker,flow:createPetImportFlow({pickDirectory:picker,worker})}
}
async function choose(flow:ReturnType<typeof createPetImportFlow>){const reply=await flow.openImportDialog();if(!reply.ok||!(reply.data.status==='ready'||reply.data.status==='choose'))throw new Error('NO_SELECTION');return reply.data}
describe('native choice and worker model management flow',()=>{
  it('discovers via worker and imports without implicit select, burning session',async()=>{
    const {flow,worker}=fixture();const view=await choose(flow)
    expect(worker.request).toHaveBeenCalledWith('discover',{directory:root})
    expect(await flow.importChosen(view.sessionId,'pet.model3.json')).toEqual({ok:true,data:{status:'imported',model:importedModel}})
    expect(await flow.importChosen(view.sessionId,'pet.model3.json')).toEqual({ok:false,error:'IMPORT_SESSION_INVALID'})
    expect(worker.request.mock.calls.some(([method])=>method==='select')).toBe(false)
  })
  it('native picker cancellation revokes old selection',async()=>{
    const {flow,picker}=fixture();const view=await choose(flow);picker.mockResolvedValue(null)
    expect(await flow.openImportDialog()).toEqual({ok:true,data:{status:'cancelled'}})
    expect((await flow.importChosen(view.sessionId,'pet.model3.json')).ok).toBe(false)
  })
  it('new pending selection immediately blocks the old capability and other operations',async()=>{
    const {flow,picker,worker}=fixture();const view=await choose(flow);let resolve!:(value:null)=>void
    picker.mockImplementation(()=>new Promise(r=>{resolve=r}));const pending=flow.openImportDialog()
    expect((await flow.importChosen(view.sessionId,'pet.model3.json')).ok).toBe(false)
    expect((await flow.openImportDialog()).ok).toBe(false)
    expect((await flow.select(importedModel.id)).ok).toBe(false)
    resolve(null);await pending
    expect((await flow.importChosen(view.sessionId,'pet.model3.json')).ok).toBe(false)
    expect(worker.request.mock.calls.some(([method])=>method==='import'||method==='select')).toBe(false)
  })
  it('cancel during asynchronous discovery cannot restore a stale session',async()=>{
    const {flow,worker}=fixture();let resolve!:(value:unknown)=>void
    worker.request.mockImplementation(()=>new Promise(r=>{resolve=r}));const pending=flow.openImportDialog();await vi.waitFor(()=>expect(worker.request).toHaveBeenCalled())
    await flow.cancelImport();resolve({ok:true,data:{entries:['pet.model3.json'],cmo3Found:false}})
    expect(await pending).toEqual({ok:true,data:{status:'cancelled'}})
  })
  it('blocks overlapping import, selection and removal until worker finishes',async()=>{
    const {flow,worker}=fixture();const view=await choose(flow);let resolve!:(value:unknown)=>void
    worker.request.mockImplementation(()=>new Promise(r=>{resolve=r}));const pending=flow.importChosen(view.sessionId,'pet.model3.json')
    expect((await flow.select(null)).ok).toBe(false);expect((await flow.remove(importedModel.id)).ok).toBe(false)
    resolve({ok:true,data:{status:'duplicate',model:importedModel}});expect((await pending).ok).toBe(true)
  })
  it('projects invalid resources into safe relative paths and fixed messages',async()=>{
    const {flow,worker}=fixture();const view=await choose(flow)
    worker.request.mockResolvedValue({ok:true,data:{status:'invalid',issues:[{code:'invalid-path',resource:'/private/user/model',message:'secret path'},{code:'missing',resource:'textures/pet.png',message:'secret'},{code:'secret payload',resource:'https://evil.test',message:'private'}]}})
    const reply=await flow.importChosen(view.sessionId,'pet.model3.json')
    expect(JSON.stringify(reply)).not.toMatch(/private|secret|https:/)
    expect(reply).toMatchObject({ok:true,data:{issues:[{resource:''},{resource:'textures/pet.png'},{code:'invalid-resource',resource:''}]}})
  })
  it('maps worker failures without selecting or exposing details',async()=>{
    const {flow,worker}=fixture();const view=await choose(flow);worker.request.mockResolvedValue({ok:false,error:'source-changed'})
    expect(await flow.importChosen(view.sessionId,'pet.model3.json')).toEqual({ok:false,error:'SOURCE_CHANGED'})
    expect(worker.request.mock.calls.some(([method])=>method==='select')).toBe(false)
  })
  it('select supports clearing current and remove returns slim state',async()=>{
    const {flow,worker}=fixture()
    expect(await flow.select(null)).toEqual({ok:true,data:{currentModelId:null,display:false,models:[importedModel]}})
    expect(worker.request).toHaveBeenCalledWith('select',{modelId:null})
    expect((await flow.remove(importedModel.id)).ok).toBe(true)
    expect(worker.request).toHaveBeenCalledWith('remove',{modelId:importedModel.id})
  })
})
describe('public model-management contract only',()=>{
  it.each([{method:'pet.state'},{method:'pet.openImportDialog'},{method:'pet.cancelImport'},{method:'pet.importChosen',sessionId:'11111111-1111-4111-8111-111111111111',entry:'pet.model3.json'},{method:'pet.select',modelId:null},{method:'pet.remove',modelId:'a'.repeat(64)}])('registers $method only at main boundary',request=>{
    expect(parseCoreRequest(request)).toEqual(request);expect(()=>parseHostRequest(request)).toThrow()
  })
  it.each(['pet.show','pet.hide'])('keeps unimplemented display method %s rejected',method=>{
    expect(()=>parseCoreRequest({method})).toThrow();expect(()=>parseHostRequest({method})).toThrow()
  })
})
