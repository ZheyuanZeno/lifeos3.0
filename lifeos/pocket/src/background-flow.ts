
export interface BackgroundStep {id:string;title:string;minutes:number;startedAt?:string;expectedEndAt?:string;handledAt?:string}
export interface BackgroundFlow {version:1;id:string;steps:BackgroundStep[];startedAt?:string;endedAt?:string}
const instant=(v:unknown):v is string=>typeof v==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v))
const only=(v:object,keys:string[])=>Object.keys(v).every(k=>keys.includes(k))
export function parseFlow(value:string):BackgroundFlow {
 if(typeof value!=='string'||value.length>10000)throw Error('后台流程格式无效')
 const f=JSON.parse(value) as BackgroundFlow,id=/^[a-zA-Z0-9_-]{1,100}$/
 if(!f||f.version!==1||typeof f.id!=='string'||!id.test(f.id)||!only(f,['version','id','steps','startedAt','endedAt'])||!Array.isArray(f.steps)||f.steps.length<1||f.steps.length>12)throw Error('后台流程格式无效')
 if(f.startedAt!==undefined&&!instant(f.startedAt)||f.endedAt!==undefined&&(!instant(f.endedAt)||!f.startedAt||Date.parse(f.endedAt)<Date.parse(f.startedAt)))throw Error('流程时间无效')
 const ids=new Set<string>();let boundary=f.startedAt?Date.parse(f.startedAt):0,blocked=false
 for(const s of f.steps){
  if(!s||!only(s,['id','title','minutes','startedAt','expectedEndAt','handledAt'])||typeof s.id!=='string'||!id.test(s.id)||ids.has(s.id)||typeof s.title!=='string'||!s.title.trim()||s.title.length>60||!Number.isInteger(s.minutes)||s.minutes<1||s.minutes>10080)throw Error('阶段名称或时长无效')
  ids.add(s.id)
  if(s.startedAt===undefined){if(s.expectedEndAt!==undefined||s.handledAt!==undefined)throw Error('阶段时间无效');blocked=true;continue}
  if(blocked||!f.startedAt||!instant(s.startedAt)||Date.parse(s.startedAt)<boundary||!instant(s.expectedEndAt)||Date.parse(s.expectedEndAt)!==Date.parse(s.startedAt)+s.minutes*60000)throw Error('阶段时间顺序无效')
  if(s.handledAt!==undefined&&(!instant(s.handledAt)||Date.parse(s.handledAt)<Date.parse(s.startedAt)))throw Error('处理时间无效')
  boundary=Date.parse(s.handledAt??s.startedAt);blocked=!s.handledAt
  if(f.endedAt&&boundary>Date.parse(f.endedAt))throw Error('流程结束时间无效')
 }
 return f
}
// Legacy metadata only: retain old backups and deterministic property merges.
export const flowRank=(flow:BackgroundFlow)=>(flow.endedAt?100:0)+(flow.startedAt?1:0)+flow.steps.reduce((n,s)=>n+(s.startedAt?1:0)+(s.handledAt?1:0),0)
