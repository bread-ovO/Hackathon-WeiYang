import { randomUUID } from 'node:crypto'
import { lstat, opendir, realpath } from 'node:fs/promises'
import path from 'node:path'

export interface DiscoveredEntries { entries: string[]; cmo3Found: boolean }
export const discoveryLimits = { maxDepth: 4, maxDirectories: 512, maxEntries: 4096, maxCandidates: 128 } as const
export class ModelDiscoveryError extends Error {
  constructor(readonly code: 'source-changed' | 'storage-limit') { super(code); this.name = 'ModelDiscoveryError' }
}
export const safeEntry = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 &&
  !/[\\:%?#\x00-\x1f\x7f]/.test(value) && !path.posix.isAbsolute(value) && value.split('/').every(part=>part!==''&&part!=='.'&&part!=='..')

/** Worker-only, bounded streamed discovery. Symlinks are skipped, never traversed.
 * Canonical ancestor/entry checks detect replacement; portable Node opendir is not
 * a sandbox against hostile same-user processes racing directory replacement.
 */
export async function findModelEntries(root: string): Promise<DiscoveredEntries> {
  try {
    if(!path.isAbsolute(root)||root.includes('\0')||root.split(path.sep).some(x=>x==='.'||x==='..')) throw new ModelDiscoveryError('source-changed')
    const target=path.resolve(root)
    let ancestor=path.parse(target).root
    const parents:{name:string;dev:number;ino:number}[]=[]
    for(const part of ['',...target.slice(ancestor.length).split(path.sep).filter(Boolean)]) {
      if(part)ancestor=path.join(ancestor,part)
      const stat=await lstat(ancestor)
      if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(ancestor)!==ancestor)throw new ModelDiscoveryError('source-changed')
      parents.push({name:ancestor,dev:stat.dev,ino:stat.ino})
    }
    const entries:string[]=[];let cmo3Found=false, directories=0, inspected=0
    async function walk(directory:string,depth:number):Promise<void> {
      if(depth>discoveryLimits.maxDepth || ++directories>discoveryLimits.maxDirectories)throw new ModelDiscoveryError('storage-limit')
      const before=await lstat(directory)
      if(!before.isDirectory()||before.isSymbolicLink()||await realpath(directory)!==directory)throw new ModelDiscoveryError('source-changed')
      const stream=await opendir(directory,{bufferSize:16})
      for await(const entry of stream) {
        if(++inspected>discoveryLimits.maxEntries)throw new ModelDiscoveryError('storage-limit')
        const full=path.join(directory,entry.name), stat=await lstat(full)
        if(stat.isSymbolicLink())continue
        if(await realpath(full)!==full)throw new ModelDiscoveryError('source-changed')
        if(stat.isDirectory())await walk(full,depth+1)
        else if(stat.isFile()) {
          const relative=path.relative(target,full).split(path.sep).join('/')
          if(entry.name.endsWith('.model3.json')) {
            if(!safeEntry(relative))throw new ModelDiscoveryError('source-changed')
            if(entries.length>=discoveryLimits.maxCandidates)throw new ModelDiscoveryError('storage-limit')
            entries.push(relative)
          } else if(entry.name.toLowerCase().endsWith('.cmo3'))cmo3Found=true
        }
      }
      const after=await lstat(directory)
      if(!after.isDirectory()||after.isSymbolicLink()||after.dev!==before.dev||after.ino!==before.ino||after.mtimeMs!==before.mtimeMs||await realpath(directory)!==directory)throw new ModelDiscoveryError('source-changed')
    }
    await walk(target,0)
    for(const item of parents) {
      const stat=await lstat(item.name)
      if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==item.dev||stat.ino!==item.ino||await realpath(item.name)!==item.name)throw new ModelDiscoveryError('source-changed')
    }
    return {entries:entries.sort(),cmo3Found}
  }catch(error){throw new ModelDiscoveryError(error instanceof ModelDiscoveryError?error.code:'source-changed')}
}
export const importSessionTtlMs=10*60_000
/** One-use native selection capability, expiring even if the clock moves backwards. */
export class ImportSession {
  private selection:{directory:string;entries:string[];id:string;created:number}|undefined
  constructor(private readonly now:()=>number=Date.now){}
  choose(directory:string,discovered:DiscoveredEntries) {
    this.clear()
    if(!Array.isArray(discovered.entries)||discovered.entries.length>discoveryLimits.maxCandidates||discovered.entries.some(x=>!safeEntry(x))||typeof discovered.cmo3Found!=='boolean')throw new ModelDiscoveryError('source-changed')
    const entries=[...new Set(discovered.entries)]
    if(!entries.length)return {status:'no-model' as const,cmo3Found:discovered.cmo3Found}
    const sessionId=randomUUID()
    this.selection={directory,entries:[...entries],id:sessionId,created:this.now()}
    return entries.length===1?{status:'ready' as const,sessionId,entry:entries[0]!,entries}:{status:'choose' as const,sessionId,entries}
  }
  consume(sessionId:string,entry:string):string|null {
    const selected=this.selection
    if(!selected)return null
    const age=this.now()-selected.created
    if(!Number.isFinite(age)||age<0||age>=importSessionTtlMs){this.clear();return null}
    if(selected.id!==sessionId||!safeEntry(entry)||!selected.entries.includes(entry))return null
    this.clear();return selected.directory
  }
  pending(){return this.selection!==undefined}
  clear(){this.selection=undefined}
}
