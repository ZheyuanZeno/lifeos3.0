import type { Operation } from './model'
import {timerState} from './shared-timer'
export const sees=(a:Operation,b:Operation)=>(a.context[b.deviceId]??0)>=b.sequence
export const compare=(a:Operation,b:Operation)=>a.clock-b.clock||(a.deviceId<b.deviceId?-1:a.deviceId>b.deviceId?1:0)||(a.id<b.id?-1:a.id>b.id?1:0)
export function materialize(operations:Operation[],legacyTimers=false) {
  const fields=new Map<string,Operation[]>()
  for(const op of operations)for(const key of Object.keys(op.patch)){const list=fields.get(key)??[];list.push(op);fields.set(key,list)}
  const row:Record<string,unknown>={id:operations[0]?.recordId};const conflicts:{field:string;versions:{opId:string;value:unknown}[]}[]=[]
  for(const [field,candidates] of fields){
    // A fresh install's defaults never overwrite a real record from another device.
    const normal=candidates.filter(o=>o.origin!=='seed'),ops=normal.length?normal:candidates
    const heads=ops.filter(a=>!ops.some(b=>b.id!==a.id&&sees(b,a)))
    const ordered=heads.toSorted(compare)
    // Deletion wins concurrent stale edits. An intentional observed restore can still win causally.
    const winner=(['deleted','archived'].includes(field)&&heads.some(o=>o.patch[field]===true)?heads.filter(o=>o.patch[field]===true).toSorted(compare):ordered).at(-1)!
    row[field]=winner.patch[field]
    if(['body','title'].includes(field)&&new Set(heads.map(o=>JSON.stringify(o.patch[field]))).size>1)conflicts.push({field,versions:ordered.map(o=>({opId:o.id,value:o.patch[field]}))})
  }
  if(!legacyTimers&&operations[0]?.entity==='sessions'){
    for(const key of ['startedAt','endedAt','pauses'])delete row[key]
    Object.assign(row,timerState(operations))
  }
  return {row,conflicts}
}
