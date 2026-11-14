import type {Operation,Session} from './model'
const controls=['startedAt','endedAt','pauses'] as const
const sees=(a:Operation,b:Operation)=>(a.context[b.deviceId]??0)>=b.sequence
const compare=(a:Operation,b:Operation)=>a.clock-b.clock||(a.deviceId<b.deviceId?-1:a.deviceId>b.deviceId?1:0)||(a.id<b.id?-1:a.id>b.id?1:0)
const heads=(ops:Operation[])=>ops.filter(a=>!ops.some(b=>b.id!==a.id&&sees(b,a)))
// Timer controls form one causal snapshot. Ending is terminal for this session ID.
// Legacy partial patches are reconstructed only from the selected action's ancestors.
export function timerState(operations:Operation[]){
  const actions=operations.filter(o=>controls.some(k=>k in o.patch)),ended=actions.filter(o=>typeof o.patch.endedAt==='string')
  const winner=heads(ended.length?ended:actions).toSorted(compare).at(-1)
  if(!winner)return {}
  const ancestors=operations.filter(o=>o.id===winner.id||sees(winner,o)),state:Record<string,unknown>={}
  for(const key of controls){const candidates=ancestors.filter(o=>key in o.patch),op=heads(candidates).toSorted(compare).at(-1);if(op)state[key]=op.patch[key]}
  return state
}
export function openSessions(sessions:Session[]){return sessions.filter(s=>!s.deleted&&!s.endedAt).toSorted((a,b)=>a.startedAt.localeCompare(b.startedAt)||a.id.localeCompare(b.id))}
