import {db as defaultDB,type PocketDatabase} from './database'
import {transaction,savePlan,saveRecord,startSession,endSession,setRecordCompletion} from './repository'
import {flowOf,waitingStep,nextStep,parseFlow,type BackgroundStep} from './background-flow'
import {uuid,type LifeRecord} from './model'
import {openSessions} from './shared-timer'

export async function saveFlow(input:{id?:string;title:string;date:string;body:string;steps:Pick<BackgroundStep,'title'|'minutes'>[]},database=defaultDB,expected?:string){return transaction(database,async()=>{
 const old=input.id?await database.records.get(input.id):undefined,prior=old&&flowOf(old)
 if(input.id&&!prior)throw Error('找不到后台流程')
 const flow=prior?.startedAt?prior:{version:1 as const,id:prior?.id??uuid(),steps:input.steps.map(s=>({id:uuid(),title:s.title.trim(),minutes:s.minutes}))}
 parseFlow(JSON.stringify(flow))
 const row=await savePlan({id:input.id,title:input.title,date:input.date,body:input.body},database,expected)
 return saveRecord({...row,properties:{...row.properties,background_flow:JSON.stringify(flow)}},database)
})}
async function read(id:string,database:PocketDatabase,expected?:string){const row=await database.records.get(id),flow=row&&flowOf(row);if(!row||row.deleted||row.status==='done'||!flow)throw Error('找不到进行中的后台流程');if(expected!==undefined&&expected!==row.properties.background_flow)throw Error('流程已变化，请重试');return {row,flow}}
function save(row:LifeRecord,flow:NonNullable<ReturnType<typeof flowOf>>,database:PocketDatabase){return saveRecord({...row,properties:{...row.properties,background_flow:JSON.stringify(flow)}},database)}
export async function handleFlow(id:string,at=Date.now(),database=defaultDB,expected?:string){return transaction(database,async()=>{
 const {row,flow}=await read(id,database,expected),active=openSessions(await database.sessions.toArray())
 if(active.some(s=>s.subjectKind!=='record'||s.subjectId!==id))throw Error('请先结束当前任务')
 const waiting=waitingStep(flow),now=new Date(at).toISOString()
 const boundary=waiting?.startedAt??flow.steps.filter(s=>s.handledAt).at(-1)?.handledAt??flow.startedAt
 if(boundary&&at<Date.parse(boundary))throw Error('系统时间早于上次处理时间')
 if(waiting){if(at<Date.parse(waiting.startedAt!))throw Error('系统时间早于阶段开始时间');waiting.handledAt=now}
 flow.startedAt??=now;await save(row,flow,database)
 return startSession('record',id,at,database)
})}
export async function advanceFlow(id:string,at=Date.now(),database=defaultDB,expected?:string){return transaction(database,async()=>{
 const {row,flow}=await read(id,database,expected)
 if(waitingStep(flow))throw Error('该阶段正在后台运行')
 const active=openSessions(await database.sessions.toArray()).find(s=>s.subjectKind==='record'&&s.subjectId===id)
 if(!active)throw Error('请先开始处理')
 const step=nextStep(flow)
 if(!step){await setRecordCompletion(id,true,database,at);return}
 for(const session of openSessions(await database.sessions.toArray()).filter(s=>s.subjectKind==='record'&&s.subjectId===id))await endSession(session.id,at,database)
 step.startedAt=new Date(at).toISOString();step.expectedEndAt=new Date(at+step.minutes*60000).toISOString()
 await save(row,flow,database)
})}
