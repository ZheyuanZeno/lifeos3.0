import { db } from './database'
import { applyOperations } from './repository'
import type { Operation } from './model'
import { uploadDesktopAudio,downloadDesktopAudio } from './media-bridge'
export const isDesktop=()=>['127.0.0.1','localhost'].includes(location.hostname)
let running:Promise<void>|undefined
export async function exchangeDesktop(){
  if(!isDesktop())throw Error('本机交换仅用于电脑白板；手机请在设置中连接 Google Drive')
  if(running)return running
  running=(async()=>{
    const state=await fetch('/api/state',{cache:'no-store',signal:AbortSignal.timeout(10000)})
    if(!state.ok)throw Error('本机白板未启动，记录已保存在本地')
    const {token}=await state.json()
    await uploadDesktopAudio(db,token)
    const pending=await db.operations.where('uploaded').equals(0).toArray()
    const response=await fetch('/api/pocket/exchange',{method:'POST',headers:{'Content-Type':'application/json','X-LifeOS-Token':token},body:JSON.stringify({protocol:1,operations:pending}),signal:AbortSignal.timeout(20000)})
    if(!response.ok){const error=await response.json();throw Error(error.error??'本机交换失败，可重试')}
    const result=await response.json() as {protocol:number;operations:Operation[]}
    if(result.protocol!==1||!Array.isArray(result.operations))throw Error('本机交换协议不兼容')
    await applyOperations(result.operations)
    await db.transaction('rw',[db.operations,db.local],async()=>{await db.operations.where('id').anyOf(pending.map(o=>o.id)).modify({uploaded:1});await db.local.put({key:'lastDesktopExchange',value:new Date().toISOString()})})
    await downloadDesktopAudio(db)
  })().finally(()=>{running=undefined})
  return running
}
