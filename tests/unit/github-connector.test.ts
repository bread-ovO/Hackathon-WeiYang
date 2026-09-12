import { describe, expect, it, vi } from 'vitest'
import { createGithubPullRequestsFetcher, GithubRateLimitError } from '../../packages/connectors/src/github'
const signal=()=>new AbortController().signal
const pr=(number=1)=>({number,title:'Fictional PR',html_url:`https://github.com/org/project/pull/${number}`,url:`https://api.github.com/repos/org/project/pulls/${number}`,state:'open',merged_at:null,updated_at:'2026-09-13T00:00:00Z',draft:false,base:{ref:'main',sha:'a'.repeat(40),repo:{id:123,full_name:'org/project'}},head:{ref:'feature',sha:'b'.repeat(40),label:'fork:feature',repo:{full_name:'fork/project'}}})
const response=(body:unknown=[pr()],headers:Record<string,string>={},status=200)=>({body,headers,status})
const pageLink=(page=2,endpoint='/repos/org/project/pulls')=>`<https://api.github.com${endpoint}?state=all&per_page=100&sort=created&direction=asc&page=${page}>; rel="next"`
const client=(transport=vi.fn().mockResolvedValue(response()))=>({fetch:createGithubPullRequestsFetcher('fictional-token','org','project',transport),transport})
describe('selected repository GitHub PR connector',()=>{
  it('requests all states with stable order and projects explicit base/head metadata',async()=>{
    const {fetch,transport}=client();const result=await fetch('',signal())
    expect(transport.mock.calls[0]![0]).toMatchObject({allowedDomain:'api.github.com',bearerToken:'fictional-token',headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10'}})
    expect(new URL(transport.mock.calls[0]![0].url).searchParams.get('state')).toBe('all')
    expect(JSON.parse(result.events[0]!.text)).toMatchObject({state:'open',base:{ref:'main'},head:{ref:'feature',repository:'fork/project'}})
    expect(result.events[0]).toMatchObject({sourceInstanceId:'github:org/project',externalId:'pr:1',role:'tool'})
  })
  it('distinguishes merged, closed unmerged and draft PRs',async()=>{
    const {fetch}=client(vi.fn().mockResolvedValue(response([{...pr(1),state:'closed',merged_at:'2026-09-12T00:00:00Z'},{...pr(2),state:'closed'},{...pr(3),draft:true}])))
    expect((await fetch('',signal())).events.map(event=>JSON.parse(event.text))).toMatchObject([{state:'merged'},{state:'closed'},{state:'open',draft:true}])
  })
  it('uses Link rather than item count and accepts selected numeric repository links',async()=>{
    const {fetch,transport}=client(vi.fn().mockResolvedValueOnce(response([pr()],{link:pageLink(2,'/repositories/123/pulls')})).mockResolvedValueOnce(response([])))
    expect((await fetch('',signal())).nextCursor).toBe('2');expect((await fetch('2',signal())).nextCursor).toBe('')
    expect(new URL(transport.mock.calls[1]![0].url).searchParams.get('page')).toBe('2')
  })
  it('does not invent another page from 100 records',async()=>{
    const {fetch}=client(vi.fn().mockResolvedValue(response(Array.from({length:100},(_,i)=>pr(i+1)))))
    expect((await fetch('',signal())).nextCursor).toBe('')
  })
  it('reuses URL-specific ETags and returns isolated cached results on 304',async()=>{
    const {fetch,transport}=client(vi.fn().mockResolvedValueOnce(response([pr()],{etag:'W/"first"',link:pageLink()})).mockResolvedValueOnce(response(null,{},304)))
    const first=await fetch('',signal());first.events[0]!.text='mutated'
    const second=await fetch('1',signal())
    expect(second.events[0]!.text).not.toBe('mutated');expect(second.nextCursor).toBe('2')
    expect(transport.mock.calls[1]![0].headers['If-None-Match']).toBe('W/"first"')
  })
  it('does not send another page ETag and rejects 304 without cache',async()=>{
    const {fetch,transport}=client(vi.fn().mockResolvedValueOnce(response([pr()],{etag:'"first"'})).mockResolvedValueOnce(response(null,{},304)))
    await fetch('',signal());await expect(fetch('2',signal())).rejects.toMatchObject({code:'INVALID_GITHUB_RESPONSE'})
    expect(transport.mock.calls[1]![0].headers['If-None-Match']).toBeUndefined()
  })
  it('bounds ETag cache to 32 URLs',async()=>{
    const {fetch,transport}=client(vi.fn().mockResolvedValue(response([],{etag:'"tag"'})))
    for(let page=1;page<=33;page++)await fetch(String(page),signal())
    await fetch('1',signal());expect(transport.mock.calls[33]![0].headers['If-None-Match']).toBeUndefined()
  })
  it.each(['0','01','-1','1e2','10001','https://evil.test/','1?token=x'])('rejects unsafe cursor %s',async(cursor)=>{
    const {fetch,transport}=client();await expect(fetch(cursor,signal())).rejects.toMatchObject({code:'INVALID_GITHUB_CURSOR'});expect(transport).not.toHaveBeenCalled()
  })
  it.each([
    {html_url:'https://evil.test/org/project/pull/1'},
    {html_url:'https://@github.com/org/project/pull/1'},
    {url:'https://api.github.com/repos/org/other/pulls/1'},
    {base:{...pr().base,repo:{id:123,full_name:'org/other'}}},
    {updated_at:'not-a-date'}, {merged_at:'2026-09-12T00:00:00Z'}, {draft:'false'}, {number:1.5}, {title:''}, {head:null},
  ])('rejects malformed PR identity or fields %j',async(patch)=>{
    const {fetch}=client(vi.fn().mockResolvedValue(response([{...pr(),...patch}])))
    await expect(fetch('',signal())).rejects.toMatchObject({code:'INVALID_GITHUB_RESPONSE'})
  })
  it.each([pageLink().replace('api.github.com','evil.test'),pageLink().replace('/org/project/','/org/other/'),pageLink(1),pageLink().replace('state=all','state=open'),pageLink(2,'/repositories/999/pulls')])('rejects escaping/nonprogressing pagination %s',async(link)=>{
    const {fetch}=client(vi.fn().mockResolvedValue(response([pr()],{link})))
    await expect(fetch('',signal())).rejects.toMatchObject({code:'INVALID_GITHUB_RESPONSE'})
  })
  it.each([429,403])('exposes bounded code and retry delay for %s',async(status)=>{
    const {fetch}=client(vi.fn().mockResolvedValue(response({secret:'never show'},{'Retry-After':'120'},status)))
    const error=await fetch('',signal()).catch(value=>value)
    expect(error).toBeInstanceOf(GithubRateLimitError);expect(error).toMatchObject({message:'GITHUB_RATE_LIMITED',retryAfterMs:120000})
  })
  it('uses rate reset when remaining budget is zero',async()=>{
    const now=vi.spyOn(Date,'now').mockReturnValue(100000)
    try{
      const {fetch}=client(vi.fn().mockResolvedValue(response(null,{'x-ratelimit-remaining':'0','x-ratelimit-reset':'180'},403)))
      await expect(fetch('',signal())).rejects.toMatchObject({retryAfterMs:80000})
    }finally{now.mockRestore()}
  })
  it('cancels before request and discards late responses without caching',async()=>{
    const controller=new AbortController();controller.abort();const {fetch,transport}=client()
    await expect(fetch('',controller.signal)).rejects.toMatchObject({code:'GITHUB_CANCELLED'});expect(transport).not.toHaveBeenCalled()
    const active=new AbortController();transport.mockImplementationOnce(async()=>{active.abort();return response([pr()],{etag:'"bad"'})})
    await expect(fetch('',active.signal)).rejects.toMatchObject({code:'GITHUB_CANCELLED'})
    await fetch('',signal());expect(transport.mock.calls[1]![0].headers['If-None-Match']).toBeUndefined()
  })
  it('does not poison repository identity after an invalid page',async()=>{
    const {fetch}=client(vi.fn().mockResolvedValueOnce(response([{...pr(),base:{...pr().base,repo:{id:999,full_name:'org/project'}}},{}])).mockResolvedValueOnce(response()))
    await expect(fetch('',signal())).rejects.toMatchObject({code:'INVALID_GITHUB_RESPONSE'})
    expect((await fetch('',signal())).events).toHaveLength(1)
  })
  it('rejects duplicated records and unsafe ETag bytes',async()=>{
    const {fetch}=client(vi.fn().mockResolvedValueOnce(response([pr(),pr()])).mockResolvedValueOnce(response([pr()],{etag:'"bad\u0000tag"'})))
    await expect(fetch('',signal())).rejects.toMatchObject({code:'INVALID_GITHUB_RESPONSE'})
    await expect(fetch('',signal())).rejects.toMatchObject({code:'INVALID_GITHUB_RESPONSE'})
  })
  it('rejects dot repository names before transport access',()=>{
    expect(()=>createGithubPullRequestsFetcher('token','org','..',vi.fn())).toThrow('INVALID_GITHUB_CLIENT_CONFIG')
  })
  it('sanitizes transport exceptions and refuses custom base URLs',async()=>{
    const {fetch}=client(vi.fn().mockRejectedValue(new Error('token secret and private URL')))
    await expect(fetch('',signal())).rejects.toMatchObject({message:'GITHUB_REQUEST_FAILED'})
    expect(()=>createGithubPullRequestsFetcher('token','org','repo','https://private' as never)).toThrow('INVALID_GITHUB_CLIENT_CONFIG')
  })
})
