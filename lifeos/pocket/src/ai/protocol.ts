import {validDate} from '../model'
export const BEGIN='LIFEOS_CMD_V1_BEGIN',END='LIFEOS_CMD_V1_END'
export const LIMIT=50,MAX_TEXT=262144
export interface Action {action:'create_plan'|'update_plan'|'complete_plan'|'create_note'|'update_note';target_id?:string;expected_version?:string;data:Record<string,string>}
export interface Command {protocol:'lifeos-ai-v1';command_id:string;created_at:string;source:{provider:string;reference:string};operations:(Action|{action:'batch_import';operations:Action[]})[]}
const fail=(s:string):never=>{throw Error(s)}
function object(v:unknown,keys:string[]):asserts v is Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fail('未知字段或结构无效')}
const text=(v:unknown,max:number)=>typeof v==='string'&&v.length>0&&v.length<=max
const calendar=(v:unknown)=>validDate(v)&&!v.startsWith('0000')
export function instant(v:unknown){return typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(Z|[+-]\d\d:\d\d)$/.test(v)&&calendar(v.slice(0,10))&&Number.isFinite(Date.parse(v))}
export function actions(c:Command):Action[]{return c.operations.flatMap(o=>o.action==='batch_import'?o.operations:[o])}
export function validateCommand(v:unknown):Command {
 object(v,['protocol','command_id','created_at','source','operations'])
 if(v.protocol!=='lifeos-ai-v1'||!text(v.command_id,100)||!/^[\w-]+$/.test(String(v.command_id))||!instant(v.created_at))fail('协议、命令编号或时间无效')
 object(v.source,['provider','reference']);if(!text(v.source.provider,80)||!text(v.source.reference,300))fail('来源无效')
 if(!Array.isArray(v.operations)||!v.operations.length||v.operations.length>LIMIT)fail('操作数量必须为 1–50')
 const result=v as unknown as Command
 for(const o of result.operations){if(o.action==='batch_import'){object(o,['action','operations']);if(!Array.isArray(o.operations)||!o.operations.length)fail('批量结构无效')} }
 const flat=actions(result);if(flat.length>LIMIT)fail('一次最多 50 个操作')
 for(const a of flat){
  object(a,['action','data','target_id','expected_version'])
  if(!['create_plan','update_plan','complete_plan','create_note','update_note'].includes(a.action))fail('不支持的业务动作')
  const create=a.action.startsWith('create_')
  if(!create&&(!text(a.target_id,100)||!text(a.expected_version,64)||!/^[a-f0-9]{64}$/.test(a.expected_version!)))fail('修改必须指定目标和 expected_version')
  if(create&&(a.target_id!==undefined||a.expected_version!==undefined))fail('新建不能指定修改目标')
  object(a.data,['title','date','deadline','planned_start','time_zone','body','source_id','module_id'])
  for(const [k,value] of Object.entries(a.data))if(typeof value!=='string'||value.length>(k==='body'?10000:k==='source_id'?300:200))fail('字段长度无效')
  if(create&&(!a.data.title?.trim()||!calendar(a.data.date)))fail('新建必须有标题和日期')
  if(a.data.title!==undefined&&!a.data.title.trim())fail('标题不能为空')
  if(a.data.date!==undefined&&!calendar(a.data.date))fail('日期无效')
  for(const k of ['date','deadline'])if(a.data[k]&&!calendar(a.data[k]))fail('日期无效')
  if(a.data.planned_start&&!instant(a.data.planned_start))fail('开始时间无效')
  if(a.data.planned_start&&!a.data.time_zone)fail('具体开始时间需要 IANA 时区')
  if(a.data.time_zone)try{new Intl.DateTimeFormat('en',{timeZone:a.data.time_zone})}catch{fail('时区无效')}
  if(a.action==='complete_plan'&&Object.keys(a.data).length)fail('完成操作 data 必须为空')
  if(!create&&a.data.module_id!==undefined)fail('v1 不支持移动记录模块')
  if(a.action.endsWith('note')&&['deadline','planned_start','time_zone'].some(k=>k in a.data))fail('笔记不支持计划时间')
 }
 if(JSON.stringify(v).length>MAX_TEXT)fail('命令过大')
 return result
}
export function parseInbox(text:string){
 if(text.length>MAX_TEXT*4)fail('Inbox 过大，请轮换文档')
 const commands:Command[]=[],errors:string[]=[];let cursor=0
 while(true){const start=text.indexOf(BEGIN,cursor);if(start<0)break;const end=text.indexOf(END,start+BEGIN.length),nested=text.indexOf(BEGIN,start+BEGIN.length)
  if(end<0){errors.push('不完整命令块');break}
  if(nested>=0&&nested<end){errors.push('不完整命令块');cursor=nested;continue}
  try{commands.push(validateCommand(JSON.parse(text.slice(start+BEGIN.length,end).trim())))}catch(e){errors.push(e instanceof Error?e.message:'JSON 无效')}
  if(commands.length+errors.length>100)fail('一次最多领取 100 个块，请轮换文档');cursor=end+END.length
 }
 return {commands,errors}
}
export function parseFile(text:string){if(text.length>MAX_TEXT)fail('JSON 文件过大');return text.trimStart().startsWith('{')?{commands:[validateCommand(JSON.parse(text))],errors:[]}:parseInbox(text)}
export const canonical=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x)
export async function digest(v:unknown){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(v))))].map(b=>b.toString(16).padStart(2,'0')).join('')}
