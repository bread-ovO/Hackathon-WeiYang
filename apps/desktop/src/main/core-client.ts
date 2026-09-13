import { utilityProcess, type UtilityProcess } from 'electron'
import { randomUUID } from 'node:crypto'
import { parseCoreReply, type CoreReply, type CoreRequest } from '@memo/contracts'
export class CoreClient {
  private child:UtilityProcess|null = null
  private ready = false
  private stopped = false
  private restarts = 0
  private restartTimer:ReturnType<typeof setTimeout>|undefined
  private pending = new Map<string,{resolve:(value:CoreReply)=>void;timer:ReturnType<typeof setTimeout>}>()
  constructor(private entry:string, private databasePath:string) {}
  start():void {
    if (this.child || this.stopped) return
    const child = utilityProcess.fork(this.entry,[this.databasePath],{serviceName:'Memo Core',stdio:'ignore'})
    this.child = child
    child.on('message',(message:unknown) => {
      if (!message || typeof message !== 'object') return
      if ('ready' in message && message.ready === true) { this.ready=true; return }
      if ('id' in message && typeof message.id === 'string' && 'reply' in message) {
        const pending=this.pending.get(message.id)
        if (pending) {
          clearTimeout(pending.timer);this.pending.delete(message.id)
          try {pending.resolve(parseCoreReply(message.reply))}catch{pending.resolve({ok:false,error:'INTERNAL_ERROR'})}
        }
      }
    })
    child.on('exit',() => {
      this.child=null;this.ready=false;this.flush()
      // Bounded retries; repeated startup failures remain visible instead of looping forever.
      if (!this.stopped && this.restarts < 3) {
        this.restarts++;this.restartTimer=setTimeout(()=>this.start(),500*this.restarts)
      }
    })
  }
  request(request:CoreRequest):Promise<CoreReply> {
    if (!this.ready || !this.child || this.pending.size >= 32) return Promise.resolve({ok:false,error:'CORE_UNAVAILABLE'})
    const id=randomUUID()
    return new Promise(resolve => {
      const timer=setTimeout(()=>{this.pending.delete(id);resolve({ok:false,error:'CORE_UNAVAILABLE'})},3000)
      this.pending.set(id,{resolve,timer})
      this.child?.postMessage({id,request})
    })
  }
  private flush() { for (const p of this.pending.values()) {clearTimeout(p.timer);p.resolve({ok:false,error:'CORE_UNAVAILABLE'})};this.pending.clear() }
  stop() {this.stopped=true;clearTimeout(this.restartTimer);this.flush();this.child?.kill()}
}
