import { openStore } from '@memo/storage'
import { parseCoreRequest, type CoreReply } from '@memo/contracts'
const parentPort = (process as unknown as {parentPort:{ on(event:'message',listener:(event:{data:unknown})=>void):void; postMessage(data:unknown):void }}).parentPort
const path = process.argv[2]
if (!path || !parentPort) throw new Error('CORE_STARTUP_INVALID')
const store = openStore(path)
parentPort.on('message', ({data}) => {
  if (!data || typeof data !== 'object' || !('id' in data) || !('request' in data) || typeof data.id !== 'string') return
  let reply:CoreReply
  try { parseCoreRequest(data.request); reply = {ok:true,data:store.health()} }
  catch { reply = {ok:false,error:'INVALID_REQUEST'} }
  parentPort.postMessage({id:data.id,reply})
})
process.on('exit', () => store.close())
parentPort.postMessage({ready:true})
