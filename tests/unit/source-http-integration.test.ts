import { EventEmitter } from 'node:events'
import type { RequestOptions } from 'node:https'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createGithubPullRequestsFetcher, GithubRateLimitError } from '../../packages/connectors/src/github'
import { createFeishuMessagesFetcher, FeishuHistoryAdapter } from '../../packages/connectors/src/feishu'
import { createSourceHttpTransport } from '../../apps/desktop/src/main/source-http'

// Product adapter, host capability, and HTTPS transport are all real. Only the OS
// DNS/TLS boundary is synthetic: no public network, credentials, or user data.
const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }))
vi.mock('node:https', () => ({ request: network.request }))
type PlannedResponse = { status?: number; headers?: Record<string,string>; body?: unknown; bytes?: Uint8Array; pause?: boolean }
let plan: PlannedResponse[]
let requests: Array<EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }>
let responses: Array<EventEmitter & { statusCode: number; headers: Record<string,string>; complete: boolean; destroy: ReturnType<typeof vi.fn> }>
const token = 'fictional-combination-token'
const signal = () => new AbortController().signal
const pull = { number:1,title:'Fictional integration PR',html_url:'https://github.com/org/project/pull/1',url:'https://api.github.com/repos/org/project/pulls/1',state:'closed',merged_at:'2026-09-13T00:00:00Z',updated_at:'2026-09-13T00:01:00Z',draft:false,base:{ref:'main',sha:'a'.repeat(40),repo:{id:123,full_name:'org/project'}},head:{ref:'feature',sha:'b'.repeat(40),label:'fork:feature',repo:{full_name:'fork/project'}} }
const nextLink = '<https://api.github.com/repos/org/project/pulls?state=all&per_page=100&sort=created&direction=asc&page=2>; rel="next"'
const github = () => createGithubPullRequestsFetcher(token,'org','project',createSourceHttpTransport())
const feishu = () => new FeishuHistoryAdapter('feishu:fictional-chat',createFeishuMessagesFetcher(token,'oc_fictional',createSourceHttpTransport()))
function options(index: number): RequestOptions { return network.request.mock.calls[index]![0] }
function headers(index: number): Record<string,string> { return options(index).headers as Record<string,string> }
function header(index: number, key:string) { return Object.entries(headers(index)).find(([name])=>name.toLowerCase()===key.toLowerCase())?.[1] }
beforeEach(() => {
  plan=[];requests=[];responses=[]
  network.lookup.mockReset().mockResolvedValue([{address:'93.184.216.34',family:4}])
  network.request.mockReset().mockImplementation((_options, callback) => {
    const item=plan.shift()
    if(!item)throw new Error('UNPLANNED_TEST_REQUEST')
    const req=Object.assign(new EventEmitter(),{end:vi.fn(),destroy:vi.fn()})
    req.end.mockImplementation(()=>queueMicrotask(()=>{
      if(req.destroy.mock.calls.length)return
      const res=Object.assign(new EventEmitter(),{statusCode:item.status??200,headers:item.headers??{'content-type':'application/json'},complete:false,destroy:vi.fn()})
      responses.push(res);callback(res)
      if(res.destroy.mock.calls.length || item.pause)return
      if(item.bytes!==undefined)res.emit('data',Buffer.from(item.bytes))
      else if(item.body!==undefined)res.emit('data',Buffer.from(JSON.stringify(item.body)))
      res.complete=true;res.emit('end')
    }))
    requests.push(req);return req
  })
})
describe('real source adapter → host HTTP capability → HTTPS transport', () => {
  it('GitHub 200 then ETag conditional 304 reuses validated events and Link cursor',async()=>{
    plan.push({headers:{'content-type':'application/json',etag:'"revision-1"',link:nextLink},body:[pull]}, {status:304,headers:{etag:'"revision-1"'}})
    const fetch=github();const first=await fetch('',signal());const second=await fetch('',signal())
    expect(second).toEqual(first);expect(second.nextCursor).toBe('2')
    expect(header(1,'If-None-Match')).toBe('"revision-1"')
    expect(header(0,'Accept')).toBe('application/vnd.github+json')
    expect(header(0,'X-GitHub-Api-Version')).toBe('2026-03-10')
    expect(header(0,'Authorization')).toBe(`Bearer ${token}`)
    expect(JSON.stringify(first)).not.toContain(token)
    expect(options(0).path).not.toContain(token)
    expect(JSON.parse(second.events[0]!.text)).toMatchObject({state:'merged',base:{ref:'main'},head:{ref:'feature'}})
    expect(options(0)).toMatchObject({hostname:'api.github.com',servername:'api.github.com',rejectUnauthorized:true,agent:false,port:443})
    const lookupCallback=vi.fn();options(0).lookup!('api.github.com',{},lookupCallback)
    expect(lookupCallback).toHaveBeenCalledWith(null,'93.184.216.34',4)
  })
  it('GitHub follows only the validated next page and does not forward page-one ETag',async()=>{
    plan.push({headers:{'content-type':'application/json',etag:'"p1"',link:nextLink},body:[pull]}, {body:[]})
    const fetch=github();const first=await fetch('',signal());const second=await fetch(first.nextCursor,signal())
    expect(options(1).hostname).toBe('api.github.com')
    expect(new URL(`https://api.github.com${options(1).path}`).searchParams.get('page')).toBe('2')
    expect(header(1,'If-None-Match')).toBeUndefined()
    expect(second).toEqual({events:[],nextCursor:''})
  })
  it.each([429,403])('GitHub %s Retry-After survives the real transport boundary without body leakage',async(status)=>{
    plan.push({status,headers:{'content-type':'text/html','retry-after':'90'},body:{message:`do not expose ${token}`}})
    const error=await github()('',signal()).catch(value=>value)
    expect(error).toBeInstanceOf(GithubRateLimitError)
    expect(error).toMatchObject({message:'GITHUB_RATE_LIMITED',retryAfterMs:90000})
    expect(String(error)).not.toContain(token)
    expect(network.request).toHaveBeenCalledTimes(1)
  })
  it('Feishu uses its fixed host, converts milliseconds, and emits app messages as assistant',async()=>{
    plan.push({body:{code:0,data:{items:[{message_id:'om_fictional',create_time:'1700000000000',update_time:'1700000001000',sender:{sender_type:'app',id:'bot'},body:{content:JSON.stringify({text:'Fictional source message'})}}],has_more:false}}})
    const result=await feishu().pull('',signal())
    expect(options(0)).toMatchObject({hostname:'open.feishu.cn',servername:'open.feishu.cn',rejectUnauthorized:true})
    expect(options(0).path).toContain('/open-apis/im/v1/messages?')
    expect(options(0).path).toContain('container_id=oc_fictional')
    expect(header(0,'Authorization')).toBe(`Bearer ${token}`)
    expect(result.events[0]).toMatchObject({sourceInstanceId:'feishu:fictional-chat',externalId:'om_fictional',occurredAt:'2023-11-14T22:13:20.000Z',revision:'1700000001000',role:'assistant',text:'Fictional source message'})
    expect(JSON.stringify(result)).not.toContain(token)
    expect(options(0).path).not.toContain(token)
  })
  it.each(['github','feishu'])('%s rejects invalid UTF8 through the real byte decoder',async(kind)=>{
    plan.push({bytes:Uint8Array.from([0xff])})
    const pending=kind==='github'?github()('',signal()):feishu().pull('',signal())
    await expect(pending).rejects.toThrow()
    expect(network.request).toHaveBeenCalledTimes(1)
  })
  it('rejects a 304 response carrying bytes instead of reusing cached events',async()=>{
    plan.push({headers:{'content-type':'application/json',etag:'"revision-1"'},body:[pull]}, {status:304,headers:{},bytes:Buffer.from('unexpected')})
    const fetch=github();await fetch('',signal())
    await expect(fetch('',signal())).rejects.toThrow('GITHUB_REQUEST_FAILED')
  })
  it.each(['github','feishu'])('%s rejects private DNS before opening a socket',async(kind)=>{
    network.lookup.mockResolvedValue([{address:'127.0.0.1',family:4}])
    const pending=kind==='github'?github()('',signal()):feishu().pull('',signal())
    await expect(pending).rejects.toThrow()
    expect(network.request).not.toHaveBeenCalled()
  })
  it.each(['github','feishu'])('%s rejects redirects without forwarding the token',async(kind)=>{
    plan.push({status:302,headers:{location:'https://other.example/steal'},body:{secret:token}})
    const pending=kind==='github'?github()('',signal()):feishu().pull('',signal())
    const error=await pending.catch(value=>value)
    expect(error).toBeInstanceOf(Error);expect(String(error)).not.toContain(token)
    expect(network.request).toHaveBeenCalledTimes(1)
    expect(requests[0]!.destroy).toHaveBeenCalled()
  })
  it.each(['github','feishu'])('%s cancellation destroys the socket and yields no events',async(kind)=>{
    plan.push({pause:true})
    const controller=new AbortController()
    const pending=kind==='github'?github()('',controller.signal):feishu().pull('',controller.signal)
    const rejection=expect(pending).rejects.toThrow(kind==='github'?'GITHUB_CANCELLED':'FEISHU_ABORTED')
    await vi.waitFor(()=>expect(responses).toHaveLength(1))
    controller.abort()
    await rejection
    expect(requests[0]!.destroy).toHaveBeenCalled()
    expect(responses[0]!.destroy).toHaveBeenCalled()
    responses[0]!.emit('data',Buffer.from(JSON.stringify([pull])))
    responses[0]!.complete=true;responses[0]!.emit('end')
  })
})
