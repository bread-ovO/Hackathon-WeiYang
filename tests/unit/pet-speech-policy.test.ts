import { describe, it, expect } from 'vitest'
import { createPetSpeechState, configurePetSpeech, parsePetSpeechState, tickPetSpeech, isPetSpeechQuiet, PET_SPEECH_LINES, type PetSpeechState, type PetSpeechEnvironment } from '../../packages/domain/src/pet-speech'
const minute=60_000
const available: PetSpeechEnvironment={locked:false,asleep:false,fullscreen:false,visible:true,busy:false}
function fixture() {
  let now=Date.UTC(2026,8,14,9)
  let randomness=0
  const clock={now:()=>now,random:()=>randomness,localTime:(ms:number)=>({day:new Date(ms).toISOString().slice(0,10),minute:new Date(ms).getUTCHours()*60+new Date(ms).getUTCMinutes()})}
  return {clock,get now(){return now},set now(v:number){now=v},set random(v:number){randomness=v}}
}
function advance(f:ReturnType<typeof fixture>,state:PetSpeechState,minutes:number,env=available) {
  const speech:string[]=[]
  for(let i=0;i<minutes;i++) {f.now+=minute;const result=tickPetSpeech(state,env,f.clock);state=result.state;if(result.speech)speech.push(result.speech.id)}
  return {state,speech}
}
describe('opt-in local pet speech',()=>{
  it('defaults disabled with bounded local safe copy and no schedule',()=>{
    const f=fixture(),state=createPetSpeechState(f.clock)
    expect(state.preferences).toEqual({enabled:false,frequency:'normal',quietStart:1320,quietEnd:540,pausedUntil:null})
    expect(state.nextAt).toBeNull()
    expect(tickPetSpeech(state,available,f.clock)).toMatchObject({speech:null,reason:'disabled'})
    expect(PET_SPEECH_LINES.length).toBeGreaterThanOrEqual(8)
    expect(new Set(PET_SPEECH_LINES.map(l=>l.id)).size).toBe(PET_SPEECH_LINES.length)
    expect(PET_SPEECH_LINES.every(l=>l.text.length<120&&!/已经完成|你完成了/.test(l.text))).toBe(true)
  })
  it('starts a full 45-90 minute normal or 90-180 minute low cooldown',()=>{
    const f=fixture(),off=createPetSpeechState(f.clock)
    const normal=configurePetSpeech(off,{enabled:true},f.clock)
    expect(normal.nextAt).toBe(f.now+45*minute);expect(off.preferences.enabled).toBe(false)
    f.random=1-Number.EPSILON
    expect(createPetSpeechState(f.clock,{enabled:true}).nextAt).toBe(f.now+90*minute)
    expect(createPetSpeechState(f.clock,{enabled:true,frequency:'low'}).nextAt).toBe(f.now+180*minute)
    f.random=0
    expect(configurePetSpeech(normal,{frequency:'low'},f.clock).nextAt).toBe(f.now+90*minute)
    expect(configurePetSpeech(normal,{},f.clock)).toEqual(normal)
  })
  it('reserves before delivery, caps six per local day and excludes the last four IDs',()=>{
    const f=fixture(),initial=createPetSpeechState(f.clock,{enabled:true})
    const result=advance(f,initial,7*45)
    expect(result.speech).toHaveLength(6);expect(result.state.count).toBe(6)
    result.speech.forEach((id,index)=>expect(result.speech.slice(Math.max(0,index-4),index)).not.toContain(id))
    const restored=parsePetSpeechState(JSON.parse(JSON.stringify(result.state)))
    expect(tickPetSpeech(restored,available,f.clock)).toMatchObject({speech:null,reason:'daily-limit'})
    expect(initial.count).toBe(0)
    const off=configurePetSpeech(restored,{enabled:false},f.clock)
    const on=configurePetSpeech(off,{enabled:true},f.clock)
    expect(on.count).toBe(6);expect(on.recent).toEqual(restored.recent)
  })
  it.each(['locked','asleep','fullscreen','busy','visible'] as const)('suppresses %s and grants a complete cooldown after recovery',key=>{
    const f=fixture();let state=createPetSpeechState(f.clock,{enabled:true})
    state=advance(f,state,44).state
    const env={...available,[key]:key==='visible'?false:true}
    f.now+=minute
    const hidden=tickPetSpeech(state,env,f.clock)
    expect(hidden.speech).toBeNull();expect(hidden.state.nextAt).toBeNull()
    f.now+=minute
    const resumed=tickPetSpeech(hidden.state,available,f.clock)
    expect(resumed.speech).toBeNull();expect(resumed.state.nextAt).toBe(f.now+45*minute)
    expect(advance(f,resumed.state,44).speech).toHaveLength(0)
  })
  it('uses inclusive quiet start, exclusive end; equal means all-day quiet',()=>{
    expect(isPetSpeechQuiet(1320,1320,540)).toBe(true)
    expect(isPetSpeechQuiet(539,1320,540)).toBe(true)
    expect(isPetSpeechQuiet(540,1320,540)).toBe(false)
    expect(isPetSpeechQuiet(600,600,660)).toBe(true)
    expect(isPetSpeechQuiet(660,600,660)).toBe(false)
    expect(isPetSpeechQuiet(0,600,600)).toBe(true)
    expect(isPetSpeechQuiet(600,600,600)).toBe(true)
    const f=fixture();f.now=Date.UTC(2026,8,14,8,59)
    const blocked=tickPetSpeech(createPetSpeechState(f.clock,{enabled:true}),available,f.clock)
    expect(blocked.reason).toBe('quiet')
    f.now+=minute
    const resumed=tickPetSpeech(blocked.state,available,f.clock)
    expect(resumed.state.nextAt).toBe(f.now+45*minute)
    expect(resumed.speech).toBeNull()
  })
  it('pause expires without a catch-up delivery',()=>{
    const f=fixture();let state=createPetSpeechState(f.clock,{enabled:true,pausedUntil:f.now+2*minute})
    const result=tickPetSpeech(state,available,f.clock);expect(result.reason).toBe('paused');state=result.state
    f.now+=2*minute
    const resumed=tickPetSpeech(state,available,f.clock)
    expect(resumed.state.nextAt).toBe(f.now+45*minute);expect(resumed.speech).toBeNull()
  })
  it('restart and missed polls cool down instead of replaying an overdue slot',()=>{
    const f=fixture();const state=advance(f,createPetSpeechState(f.clock,{enabled:true}),45).state
    const loaded=parsePetSpeechState(JSON.parse(JSON.stringify(state)))
    f.now+=minute
    const restart=tickPetSpeech(loaded,{...available,resumed:true},f.clock)
    expect(restart.state.count).toBe(1);expect(restart.state.nextAt).toBe(f.now+45*minute)
    f.now+=4*60*minute
    const missed=tickPetSpeech(restart.state,available,f.clock)
    expect(missed.speech).toBeNull();expect(missed.state.count).toBe(1)
    expect(missed.state.nextAt).toBe(f.now+45*minute)
  })
  it('clock rollback preserves quota and a later new day resets once without immediate speech',()=>{
    const f=fixture();let state=advance(f,createPetSpeechState(f.clock,{enabled:true}),45).state
    f.now-=10*minute
    const rollback=tickPetSpeech(state,available,f.clock);state=rollback.state
    expect(state.count).toBe(1);expect(rollback.speech).toBeNull();expect(state.nextAt).toBe(f.now+45*minute)
    f.now=Date.UTC(2026,8,15,9)
    const next=tickPetSpeech(state,available,f.clock)
    expect(next.state.count).toBe(0);expect(next.speech).toBeNull()
    expect(next.state.recent).toEqual(state.recent)
    f.now=Date.UTC(2026,8,14,12)
    const oldDay=tickPetSpeech({...next.state,count:6},available,f.clock)
    expect(oldDay.state.day).toBe('2026-09-15');expect(oldDay.state.count).toBe(6)
  })
  it('validates persisted fields, rejects unknown content and returns detached state',()=>{
    const f=fixture(),state=createPetSpeechState(f.clock)
    const parsed=parsePetSpeechState(state);parsed.preferences.enabled=true;parsed.recent.push('water')
    expect(state.preferences.enabled).toBe(false);expect(state.recent).toEqual([])
    for(const patch of [{version:2},{count:7},{count:-1},{nextAt:Infinity},{day:'2026-02-30'},{recent:['water','water']},{recent:['external-prompt']},{extra:'secret'},{preferences:{...state.preferences,frequency:'high'}},{preferences:{...state.preferences,quietStart:1440}},{preferences:{...state.preferences,enabled:'true'}}])expect(()=>parsePetSpeechState({...state,...patch})).toThrow('PET_SPEECH_INVALID_STATE')
    expect(()=>configurePetSpeech(state,{unknown:true} as never,f.clock)).toThrow('PET_SPEECH_INVALID_STATE')
    expect(()=>tickPetSpeech(state,{...available,busy:undefined} as never,f.clock)).toThrow('PET_SPEECH_INVALID_STATE')
    f.random=1;expect(()=>createPetSpeechState(f.clock,{enabled:true})).toThrow('PET_SPEECH_INVALID_STATE')
  })
})
