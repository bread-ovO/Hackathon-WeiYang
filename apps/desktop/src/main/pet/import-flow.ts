import type { CoreReply, PetChooseReply, PetImportReply, PetState, PetModel } from '@memo/contracts'
import { type DiscoveredEntries, ImportSession, safeEntry } from './import-session'
import type { PetWorkerClient } from './worker-client'
const petErrorCodes=['PET_UNAVAILABLE','PET_OUTCOME_UNKNOWN','IMPORT_SESSION_INVALID','SOURCE_CHANGED','INVALID_STORE','UNKNOWN_MODEL','STORAGE_LIMIT'] as const
type PetErrorCode=(typeof petErrorCodes)[number]
const kebabCodeMap:Record<string,PetErrorCode>={'outcome-unknown':'PET_OUTCOME_UNKNOWN','source-changed':'SOURCE_CHANGED','invalid-store':'INVALID_STORE','unknown-model':'UNKNOWN_MODEL','storage-limit':'STORAGE_LIMIT'}
const petErrorCode=(code:string):PetErrorCode=>kebabCodeMap[code]??((petErrorCodes as readonly string[]).includes(code)?code as PetErrorCode:'PET_UNAVAILABLE')
export interface ImportFlowDeps {
  pickDirectory():Promise<string|null>
  worker:Pick<PetWorkerClient,'request'>
  findEntries?:(directory:string)=>Promise<DiscoveredEntries>
  now?:()=>number
}
function model(value:unknown):PetModel {
  const item=value as PetModel|undefined
  if(!item||typeof item.id!=='string'||!/^[a-f0-9]{64}$/.test(item.id)||!safeEntry(item.entry)||typeof item.importedAt!=='string'||!Number.isFinite(Date.parse(item.importedAt))||!Number.isSafeInteger(item.totalBytes)||item.totalBytes<0)throw new Error('PET_UNAVAILABLE')
  return {id:item.id,entry:item.entry,importedAt:item.importedAt,totalBytes:item.totalBytes}
}
function slimState(value:unknown):PetState {
  const state=value as {currentModelId:string|null;models:unknown[]}|undefined
  if(!state||!Array.isArray(state.models)||state.models.length>64)throw new Error('PET_UNAVAILABLE')
  const models=state.models.map(model)
  if(state.currentModelId!==null&&!models.some(item=>item.id===state.currentModelId))throw new Error('PET_UNAVAILABLE')
  return {currentModelId:state.currentModelId,display:false,models}
}
/** Main owns capabilities; expensive reads/copies/validation all run in the worker.
 * Cancelling can revoke an unconsumed selection, not undo a dispatched import.
 * Import does not select a model. Only explicit select mutates display choice.
 */
export function createPetImportFlow({pickDirectory,worker,findEntries,now}:ImportFlowDeps){
  const session=new ImportSession(now)
  let busy=false,generation=0
  let stateReading:Promise<CoreReply<PetState>>|null=null
  async function guarded<T>(operation:()=>Promise<CoreReply<T>>):Promise<CoreReply<T>>{
    if(busy)return {ok:false,error:'PET_UNAVAILABLE'}
    busy=true
    try{return await operation()}catch(error){return {ok:false,error:petErrorCode(error&&typeof error==='object'&&'code'in error?String(error.code):'PET_UNAVAILABLE')}}finally{busy=false}
  }
  async function mutate(method:'select'|'remove',modelId:string|null):Promise<CoreReply<PetState>>{
    return guarded(async()=>{
      if((method==='remove'&&modelId===null)||(modelId!==null&&(typeof modelId!=='string'||!/^[a-f0-9]{64}$/.test(modelId))))return {ok:false,error:'UNKNOWN_MODEL'}
      session.clear();generation++
      const reply=await worker.request(method,{modelId})
      return reply.ok?{ok:true,data:slimState(reply.data)}:{ok:false,error:petErrorCode(reply.error)}
    })
  }
  return {
    openImportDialog():Promise<CoreReply<PetChooseReply>>{
      return guarded<PetChooseReply>(async()=>{
        session.clear();const ticket=++generation
        const directory=await pickDirectory()
        if(ticket!==generation||!directory)return {ok:true,data:{status:'cancelled'}}
        let discovered:DiscoveredEntries
        if(findEntries)discovered=await findEntries(directory)
        else {
          const reply=await worker.request('discover',{directory})
          if(!reply.ok)return {ok:false,error:petErrorCode(reply.error)}
          discovered=reply.data as DiscoveredEntries
        }
        if(ticket!==generation)return {ok:true,data:{status:'cancelled'}}
        return {ok:true,data:session.choose(directory,discovered)}
      })
    },
    async cancelImport():Promise<CoreReply<{status:'cancelled'}>>{
      generation++;session.clear();return {ok:true,data:{status:'cancelled'}}
    },
    importChosen(sessionId:string,entry:string):Promise<CoreReply<PetImportReply>>{
      return guarded<PetImportReply>(async()=>{
        const directory=session.consume(sessionId,entry)
        if(!directory)return {ok:false,error:'IMPORT_SESSION_INVALID'}
        const reply=await worker.request('import',{directory,entry})
        if(!reply.ok)return {ok:false,error:petErrorCode(reply.error)}
        const result=reply.data as PetImportReply
        if(result.status==='invalid'){
          if(!Array.isArray(result.issues)||result.issues.length>256)throw new Error('PET_UNAVAILABLE')
          return {ok:true,data:{status:'invalid',issues:result.issues.map(issue=>({
            code:['invalid-root','invalid-path','symlink','missing','not-file','read-failed','limit','invalid-json','invalid-manifest','invalid-resource','unsupported-resource'].includes(issue.code)?issue.code:'invalid-resource',
            resource:safeEntry(issue.resource)?issue.resource:'',message:'模型资源校验未通过，请检查所选模型文件。',
          }))}}
        }
        if(result.status!=='imported'&&result.status!=='duplicate')throw new Error('PET_UNAVAILABLE')
        return {ok:true,data:{status:result.status,model:model(result.model)}}
      })
    },
    state():Promise<CoreReply<PetState>>{
      // Reads share one pending worker request and never acquire/release the
      // mutation lock. The worker's bounded promise queue serializes store I/O.
      if(stateReading)return stateReading
      stateReading=(async():Promise<CoreReply<PetState>>=>{
        try {
          const reply=await worker.request('list')
          return reply.ok?{ok:true,data:slimState(reply.data)}:{ok:false,error:petErrorCode(reply.error)}
        } catch(error) {
          return {ok:false,error:petErrorCode(error&&typeof error==='object'&&'code'in error?String(error.code):'PET_UNAVAILABLE')}
        }
      })().finally(()=>{stateReading=null})
      return stateReading
    },
    select:(modelId:string|null)=>mutate('select',modelId),
    remove:(modelId:string)=>mutate('remove',modelId),
  }
}
