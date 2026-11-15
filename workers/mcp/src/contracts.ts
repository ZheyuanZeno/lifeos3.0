import {z} from 'zod'
import {validateCommand,type Command} from '../../../lifeos/pocket/src/ai/protocol'
export const scopes=['lifeos:read','lifeos:create','lifeos:modify','lifeos:notes','lifeos:daily','offline_access']
export const plan=z.object({title:z.string().trim().min(1).max(200),date:z.string().describe('事项归属日期 YYYY-MM-DD，不是提醒时刻'),deadline:z.string().optional().describe('正式截止日期，可省略'),planned_start:z.string().optional().describe('安排开始时间 ISO8601，需明确偏移；不确定先询问用户'),time_zone:z.string().optional().describe('用户 IANA 时区，先查询 get_status'),body:z.string().max(10000).optional(),source_id:z.string().max(300).optional().describe('稳定来源标识，重复图片应复用；没有时仍会检查可能重复'),reminder_minutes_before:z.number().int().min(0).max(43200).optional().describe('提前提醒分钟数；当前非零值将明确拒绝，不能忽略用户需求')}).strict()
export const descriptions:Record<string,string>={lifeos_list_daily_records:'分页读取某天每日日程中的当日记录：固定项目/计划已结束且有效超过30秒的计时、起止时间、扣除暂停的有效时长及备注。须 lifeos:daily 独立授权，先 get_status 确定日期/时区；并行用时分别累计，当前未结束计时不属于当日历史。',lifeos_get_status:'查询用户当前日期、时区、授权范围、实际生效 permissions、投影新鲜度和待处理状态。相对日期处理前先调用。',lifeos_list_plans:'按日期分页查询已授权的计划投影，未同步设备的数据可能缺失。',lifeos_get_plan:'按稳定 ID 查询一条计划及 updated_version。',lifeos_create_plan:'排队创建一条计划。command_id 重试必须不变。queued 不等于设备已写入。',lifeos_create_plans:'排队批量创建结构化安排，最多50条；稳定来源精确去重，超过10条须本机审核。不接收原图片。',lifeos_update_plan:'按查询得到的 ID 和 expected_version 排队修改计划，过期返回 conflict，本机审核后才应用。',lifeos_complete_plan:'按稳定 ID 和版本请求完成计划，仅影响目标计划；本机审核后应用。',lifeos_list_notes:'分页查询 LifeOS 随手记（note），正文需独立 lifeos:notes 授权；权限与 Google Drive 同步无关。',lifeos_create_note:'在用户允许笔记访问后排队创建笔记；聊天模型负责整理文本。',lifeos_update_note:'按稳定 ID 和 expected_version 请求修改笔记；本机审核后应用。',lifeos_get_command_status:'查询 queued/review/applied/conflict/failed；提醒后台确认与手机实际收件是独立状态。'}
export const toolSchemas={
 lifeos_get_status:z.object({}).strict(),
 lifeos_list_daily_records:z.object({date:z.string(),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(100).default(30)}).strict(),
 lifeos_list_plans:z.object({from:z.string(),to:z.string(),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(100).default(30)}).strict(),
 lifeos_get_plan:z.object({id:z.string().max(100)}).strict(),
 lifeos_create_plan:z.object({command_id:z.string().regex(/^[\w-]{1,100}$/),data:plan}).strict(),
 lifeos_create_plans:z.object({command_id:z.string().regex(/^[\w-]{1,100}$/),items:z.array(plan).min(1).max(50)}).strict(),
 lifeos_update_plan:z.object({command_id:z.string().regex(/^[\w-]{1,100}$/),id:z.string().max(100),expected_version:z.string().regex(/^[a-f0-9]{64}$/),data:plan.partial()}).strict(),
 lifeos_complete_plan:z.object({command_id:z.string().regex(/^[\w-]{1,100}$/),id:z.string().max(100),expected_version:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
 lifeos_list_notes:z.object({from:z.string(),to:z.string(),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(100).default(30)}).strict(),
 lifeos_create_note:z.object({command_id:z.string().regex(/^[\w-]{1,100}$/),data:z.object({title:z.string().min(1).max(200),date:z.string(),body:z.string().max(10000).optional(),source_id:z.string().max(300).optional()}).strict()}).strict(),
 lifeos_update_note:z.object({command_id:z.string().regex(/^[\w-]{1,100}$/),id:z.string().max(100),expected_version:z.string().regex(/^[a-f0-9]{64}$/),data:z.object({title:z.string().min(1).max(200).optional(),date:z.string().optional(),body:z.string().max(10000).optional()}).strict()}).strict(),
 lifeos_get_command_status:z.object({command_id:z.string().regex(/^[\w-]{1,100}$/)}).strict()
}
export type Tool=keyof typeof toolSchemas
export function toCommand(tool:Tool,args:any):Command{
 const original=tool==='lifeos_create_plans'?args.items:[args.data??{}],items:any[]=[],seen=new Map<string,string>()
 for(const item of original){const key=item.source_id?'source:'+item.source_id:JSON.stringify([item.title,item.date,item.planned_start]);const value=JSON.stringify(item);if(seen.has(key)){if(!item.source_id||seen.get(key)!==value)throw Error('批次可能重复或同来源内容冲突，请先核对');continue}seen.set(key,value);items.push(item)}
 if(items.some((d:any)=>(d.reminder_minutes_before??0)!==0))throw Error('当前仅支持在计划开始时提醒；提前提醒尚未支持，未排队，请先向用户说明并确认安排')
 const action=tool==='lifeos_create_plans'?'create_plan':tool.replace('lifeos_','')
 return validateCommand({protocol:'lifeos-ai-v1',command_id:args.command_id,created_at:new Date().toISOString(),source:{provider:'mcp',reference:args.command_id},operations:items.map((value:any)=>{const {reminder_minutes_before,...data}=value;return {action,data,...(args.id?{target_id:args.id,expected_version:args.expected_version}:{})}})})
}
