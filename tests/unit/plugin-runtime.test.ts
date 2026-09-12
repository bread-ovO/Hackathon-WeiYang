import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { CoreRequest, CoreReply, PluginSnapshot } from '@memo/contracts'
import { createHttpJsonReader } from '../../packages/plugin-host/src/http-json'
import { createPluginRuntime } from '../../apps/desktop/src/main/plugin-runtime'
import { HTTP_JSON_MANIFEST_EXAMPLE, LOCAL_JSONL_MANIFEST_EXAMPLE } from '../../packages/plugin-host/src/manifest'
let root: string, file: string, time: number
let choose: ReturnType<typeof vi.fn>, request: ReturnType<typeof vi.fn>, readCredential: ReturnType<typeof vi.fn>, transport: ReturnType<typeof vi.fn>
let runtime: ReturnType<typeof createPluginRuntime>
const event = { id:'1', revision:'1', created_at:'2026-09-13T00:00:00Z', role:'assistant', content:'fictional' }
const body = () => Buffer.from(JSON.stringify({ items:[event],next_cursor:null }))
function data(reply: CoreReply<PluginSnapshot>) { if(!reply.ok)throw new Error(reply.error);return reply.data }
const handle=(value: Extract<CoreRequest,{method:`plugins.${string}`}>)=>runtime.handle(value)
async function inspect(manifest: unknown=HTTP_JSON_MANIFEST_EXAMPLE) {
  await writeFile(file,JSON.stringify(manifest));choose.mockResolvedValueOnce(file)
  return data(await handle({method:'plugins.inspect'})).inspection!
}
async function trial(id:string) {
  return handle({method:'plugins.trial',inspectionId:id,projectId:'project-1',credentialId:'credential-1'})
}
beforeEach(async()=>{
  root=await realpath(await mkdtemp(path.join(tmpdir(),'bugu-plugin-runtime-')));file=path.join(root,'manifest.json');time=1000
  choose=vi.fn();readCredential=vi.fn().mockResolvedValue('fictional-token');transport=vi.fn().mockResolvedValue(body())
  request=vi.fn().mockImplementation(async(req)=>req.method==='pluginHost.list'?{ok:true,data:[]}:{ok:true,data:{}})
  runtime=createPluginRuntime({choose,request,readCredential,transport,now:()=>time})
})
afterEach(async()=>{await rm(root,{recursive:true,force:true})})
describe('plugin runtime confirmation and cancellation boundaries',()=>{
  it('trials only read and activate consumes one matching trial capability',async()=>{
    const inspection=await inspect();const result=data(await trial(inspection.inspectionId))
    expect(result.trial).toMatchObject({eventCount:1,done:true})
    expect(request.mock.calls.map(([req])=>req.method)).toEqual(['pluginHost.list','pluginHost.list','pluginHost.list'])
    expect(readCredential).toHaveBeenCalledWith('credential-1',{domain:'api.example.com',purpose:'source'})
    expect(transport.mock.calls[0]![0].bearerToken).toBe('fictional-token')
    const id=result.trial!.trialId
    expect((await handle({method:'plugins.activate',trialId:id})).ok).toBe(true)
    expect((await handle({method:'plugins.activate',trialId:id})).ok).toBe(false)
    expect(request.mock.calls.filter(([req])=>req.method==='pluginHost.activate')).toHaveLength(1)
  })
  it('failed trials cannot activate or persist source data',async()=>{
    const inspection=await inspect();transport.mockRejectedValue(new Error('fictional-secret'))
    expect(await trial(inspection.inspectionId)).toEqual({ok:false,error:'PLUGIN_TRIAL_FAILED'})
    expect((await handle({method:'plugins.activate',trialId:'invented'})).ok).toBe(false)
    expect(request.mock.calls.every(([req])=>req.method==='pluginHost.list')).toBe(true)
  })
  it('replacing inspection invalidates its previous trial and old inspection ID',async()=>{
    const first=await inspect();const tested=data(await trial(first.inspectionId)).trial!
    await inspect()
    expect((await trial(first.inspectionId)).ok).toBe(false)
    expect((await handle({method:'plugins.activate',trialId:tested.trialId})).ok).toBe(false)
  })
  it('rejects expired inspection and trial',async()=>{
    const first=await inspect();time+=600001
    expect(await trial(first.inspectionId)).toEqual({ok:false,error:'PLUGIN_CONFLICT'})
    const next=await inspect();const tested=data(await trial(next.inspectionId)).trial!;time+=600001
    expect(await handle({method:'plugins.activate',trialId:tested.trialId})).toEqual({ok:false,error:'PLUGIN_CONFLICT'})
  })
  it('does not renew an inspection lifetime through a long running trial',async()=>{
    const first=await inspect();transport.mockImplementation(async()=>{time+=600001;return body()})
    expect(await trial(first.inspectionId)).toEqual({ok:false,error:'PLUGIN_CONFLICT'})
  })
  it('returned inspection views cannot mutate internal capability or digest',async()=>{
    const first=await inspect();const original=first.inspectionId
    first.inspectionId='changed';first.digest='changed'
    const tested=data(await trial(original)).trial!
    await handle({method:'plugins.activate',trialId:tested.trialId})
    expect(request.mock.calls.find(([req])=>req.method==='pluginHost.activate')![0].input.digest).not.toBe('changed')
  })
  it('snapshots trial project and credential before awaiting credentials',async()=>{
    const first=await inspect();let release!:()=>void
    readCredential.mockImplementation(()=>new Promise<string>((resolve)=>{release=()=>resolve('fictional-token')}))
    const mutable={method:'plugins.trial' as const,inspectionId:first.inspectionId,projectId:'project-1',credentialId:'credential-1'}
    const pending=handle(mutable);mutable.projectId='other-project';mutable.credentialId='other-credential'
    release();const tested=data(await pending).trial!
    await handle({method:'plugins.activate',trialId:tested.trialId})
    expect(readCredential).toHaveBeenCalledWith('credential-1',expect.anything())
    expect(request.mock.calls.find(([req])=>req.method==='pluginHost.activate')![0].input.projectId).toBe('project-1')
  })
  it.each(['cancel','disable'] as const)('%s invalidates an in-flight trial even if transport ignores abort',async(action)=>{
    const first=await inspect();let release!:()=>void
    transport.mockImplementation(()=>new Promise<Uint8Array>((resolve)=>{release=()=>resolve(body())}))
    const pending=trial(first.inspectionId)
    await vi.waitFor(()=>expect(transport).toHaveBeenCalled())
    if(action==='cancel')runtime.cancel()
    else await handle({method:'plugins.disable',id:first.id})
    release();expect((await pending).ok).toBe(false)
    expect(request.mock.calls.some(([req])=>req.method==='pluginHost.activate')).toBe(false)
  })
  it('shared domain attempt budget cannot be reset by another trial',async()=>{
    const manifest=structuredClone(HTTP_JSON_MANIFEST_EXAMPLE) as any;manifest.transport.requestsPerMinute=1
    const first=await inspect(manifest)
    expect((await trial(first.inspectionId)).ok).toBe(true)
    expect((await trial(first.inspectionId)).ok).toBe(false)
    const next=await inspect(manifest);expect((await trial(next.inspectionId)).ok).toBe(false)
    expect(transport).toHaveBeenCalledTimes(1)
    time+=60001;expect((await trial(next.inspectionId)).ok).toBe(true)
  })
  it('reads only the manifest-selected local JSONL after directory choice without database writes',async()=>{
    const first=await inspect(LOCAL_JSONL_MANIFEST_EXAMPLE)
    await writeFile(path.join(root,'events.jsonl'),JSON.stringify(event)+'\n');choose.mockResolvedValueOnce(root)
    const result=data(await handle({method:'plugins.trial',inspectionId:first.inspectionId,projectId:'project-1'}))
    expect(result.trial?.eventCount).toBe(1)
    expect(readCredential).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled()
    expect(request.mock.calls.every(([req])=>req.method==='pluginHost.list')).toBe(true)
  })
  it.skipIf(process.platform==='win32')('rejects a symlinked local resource',async()=>{
    const first=await inspect(LOCAL_JSONL_MANIFEST_EXAMPLE)
    await writeFile(path.join(root,'actual'),JSON.stringify(event)+'\n');await symlink(path.join(root,'actual'),path.join(root,'events.jsonl'));choose.mockResolvedValueOnce(root)
    expect((await handle({method:'plugins.trial',inspectionId:first.inspectionId,projectId:'project-1'})).ok).toBe(false)
  })
  it('passes the stored HTTP cursor and abort signal through the reader options',async()=>{
    const manifest=structuredClone(HTTP_JSON_MANIFEST_EXAMPLE) as any
    manifest.transport.maxPages=1
    const authorization={sourceInstanceId:'source-1',domain:'api.example.com',credential:{id:'api-token',token:'fictional-token'}}
    const reader=createHttpJsonReader({manifest,authorization,transport:async()=>Buffer.from(JSON.stringify({items:[event],next_cursor:'page-2'})),now:()=>time})
    const previous=await reader.read()
    expect(previous.done).toBe(false)
    request.mockImplementation(async(req)=>{
      if(req.method==='pluginHost.list')return {ok:true,data:[]}
      if(req.method==='pluginHost.get')return {ok:true,data:{id:manifest.id,status:'active',manifest,grant:{kind:'http-json',domain:'api.example.com',credentialId:'credential-1'},sourceInstanceId:'source-1',projectId:'project-1',grantVersion:1,cursor:JSON.stringify(previous.cursor)}}
      return {ok:true,data:{}}
    })
    expect((await handle({method:'plugins.sync',id:manifest.id})).ok).toBe(true)
    expect(transport.mock.calls[0]![0].url).toBe('https://api.example.com/events?cursor=page-2')
    expect(transport.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal)
    expect(request.mock.calls.find(([req])=>req.method==='pluginHost.receiveBatch')![0].input.expectedCursor).toBe(JSON.stringify(previous.cursor))
  })
  it('disable prevents late sync batches from being committed',async()=>{
    const manifest=HTTP_JSON_MANIFEST_EXAMPLE
    request.mockImplementation(async(req)=>{
      if(req.method==='pluginHost.list')return {ok:true,data:[]}
      if(req.method==='pluginHost.get')return {ok:true,data:{id:manifest.id,status:'active',manifest,grant:{kind:'http-json',domain:'api.example.com',credentialId:'credential-1'},sourceInstanceId:'source-1',projectId:'project-1',grantVersion:1,cursor:''}}
      return {ok:true,data:{}}
    })
    let release!:()=>void;transport.mockImplementation(()=>new Promise<Uint8Array>((resolve)=>{release=()=>resolve(body())}))
    const pending=handle({method:'plugins.sync',id:manifest.id});await vi.waitFor(()=>expect(transport).toHaveBeenCalled())
    await handle({method:'plugins.disable',id:manifest.id});release();expect((await pending).ok).toBe(false)
    expect(request.mock.calls.some(([req])=>req.method==='pluginHost.receiveBatch')).toBe(false)
  })
})
