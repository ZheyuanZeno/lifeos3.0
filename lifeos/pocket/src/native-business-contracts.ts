import {z} from 'zod'
import {validDate} from './model'
export const nativeEntities=['modules','records','routines','completions','sessions'] as const
export const entitySchema=z.enum(nativeEntities)
const id=z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),version=z.string().regex(/^[a-f0-9]{64}$/),date=z.string().refine(validDate,'日期无效'),instant=z.string().datetime({offset:true})
const zone=z.string().max(100).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true}catch{return false}},'IANA时区无效')
const properties=z.record(id,z.string().max(10000)).refine(v=>Object.keys(v).length<=200)
const attachment=z.object({file:z.string().regex(/^[a-f0-9]{32}\.(png|jpg|jpeg|webp|gif|pdf|txt|m4a|mp4|webm|ogg|wav)$/),name:z.string().max(300)}).strict()
export const recordData=z.object({module_id:id.optional(),type:z.enum(['journal','activity','expense','task','note']).optional(),date,title:z.string().trim().min(1).max(200),body:z.string().max(100000).optional(),time_label:z.string().max(1000).optional(),amount:z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/).nullable().optional(),currency:z.string().max(100).optional(),status:z.enum(['todo','done']).optional(),source_id:z.string().max(300).optional(),properties:properties.optional(),attachments:z.array(attachment).max(30).optional(),deleted:z.boolean().optional()}).strict()
export const routineData=z.object({title:z.string().trim().min(1).max(200),icon:z.string().max(12).optional(),category:z.string().max(80).optional(),days:z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),minimumMinutes:z.number().min(0).max(1440).nullable().optional(),targetMinutes:z.number().min(1).max(1440).optional(),order:z.number().finite().optional(),archived:z.boolean().optional(),deleted:z.boolean().optional()}).strict()
export const moduleData=z.object({name:z.string().trim().min(1).max(80),kind:z.enum(['journal','health','shopping','plans','custom']),view:z.enum(['list','table']).optional(),fields:z.array(z.object({id,name:z.string().max(60),type:z.enum(['text','number','date'])}).strict()).max(30).optional(),archived:z.boolean().optional(),layout:z.object({x:z.number().finite(),y:z.number().finite(),width:z.number().positive(),height:z.number().positive()}).strict().nullable().optional()}).strict()
export const historyData=z.object({subject_id:id,subject_kind:z.enum(['routine','record']),title:z.string().max(200).optional(),started_at:instant,ended_at:instant,time_zone:zone,note:z.string().max(10000).optional(),pauses:z.array(z.object({startedAt:instant,endedAt:instant}).strict()).max(1000).optional(),deleted:z.boolean().optional()}).strict()
const base={command_id:id},create=(data:z.ZodType)=>z.object({...base,data}).strict(),update=(data:z.ZodType)=>z.object({...base,id,expected_version:version,data}).strict(),remove=z.object({...base,id,expected_version:version}).strict()
const list=z.object({entity:entitySchema,from:date.optional(),to:date.optional(),module_id:id.optional(),include_deleted:z.boolean().default(false),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(100).default(30)}).strict()
export const businessSchemas={
 lifeos_list_content:list,
 lifeos_get_content:z.object({entity:entitySchema,id}).strict(),
 lifeos_create_record:create(recordData),lifeos_update_record:update(recordData.partial()),lifeos_delete_record:remove,
 lifeos_create_idea:create(recordData.omit({type:true,status:true,deleted:true})),
 lifeos_create_routine:create(routineData),lifeos_update_routine:update(routineData.partial()),lifeos_delete_routine:remove,
 lifeos_create_module:create(moduleData),lifeos_update_module:update(moduleData.partial()),
 lifeos_create_history:create(historyData),lifeos_update_history:update(historyData.partial()),lifeos_delete_history:remove,
 lifeos_set_routine_completion:z.object({...base,routine_id:id,date,completed:z.boolean(),expected_version:version.optional()}).strict(),
 lifeos_control_timer:z.object({...base,action:z.enum(['start','pause','resume','stop']),subject_kind:z.enum(['routine','record']).optional(),subject_id:id.optional(),id:id.optional(),expected_version:version,at:instant.optional()}).strict().refine(a=>a.action==='start'?!!a.subject_kind&&!!a.subject_id:!!a.id,'开始需项目编号；其他操作需会话编号'),
 lifeos_list_attachments:z.object({record_id:id.optional(),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(100).default(30)}).strict(),
 lifeos_read_attachment:z.object({file:attachment.shape.file,offset:z.number().int().min(0).default(0),length:z.number().int().min(1).max(98304).default(98304),format:z.enum(['chunk','resource','audio']).default('chunk')}).strict()
}
export type BusinessTool=keyof typeof businessSchemas
export interface BusinessCommand {protocol:'lifeos-native-v2';command_id:string;created_at:string;tool:BusinessTool;args:any}
export function validateBusinessCommand(value:unknown):BusinessCommand{
 const c=z.object({protocol:z.literal('lifeos-native-v2'),command_id:id,created_at:instant,tool:z.enum(Object.keys(businessSchemas) as [BusinessTool,...BusinessTool[]]),args:z.unknown()}).strict().parse(value)
 if(!isBusinessWrite(c.tool))throw Error('只读工具不是写入命令')
 const args=businessSchemas[c.tool].parse(c.args) as any;if(args.command_id!==c.command_id)throw Error('命令编号不一致')
 return {...c,args}
}
export function isBusinessWrite(name:string){return !name.startsWith('lifeos_list_')&&!name.startsWith('lifeos_get_')&&name!=='lifeos_read_attachment'}
export function commandEntity(tool:BusinessTool):typeof nativeEntities[number]{if(tool.includes('routine_completion'))return 'completions';if(tool.includes('routine'))return 'routines';if(tool.includes('module'))return 'modules';if(tool.includes('history')||tool.includes('timer'))return 'sessions';return 'records'}
export const businessDescriptions:Record<BusinessTool,string>={
 lifeos_list_content:'完整业务授权后，分页读取所有模块、各类记录、固定项目、完成状态、全部计时（含正在进行）。entity为业务类型；返回稳定ID、完整正文和version。可选择日期、模块及回收站。',
 lifeos_get_content:'按entity和稳定ID读取完整业务记录及版本；修改前先查询。',
 lifeos_create_record:'新建任意现有业务类型记录：日记、完成事项、支出、计划、随手记。source_id稳定去重；不允许SQL或操作日志。',
 lifeos_update_record:'按ID和expected_version修改完整记录字段；properties为整体替换，先读取并保留未修改项；本机审核后应用。',
 lifeos_delete_record:'请求将一条记录移入回收站，保留历史及附件；本机审核后应用。',
 lifeos_create_idea:'新增想法到随手记/指定自定义模块，保存正文和可选标签属性。',
 lifeos_create_routine:'新增固定项目，支持名称、分类、重复日、目标分钟及顺序。',lifeos_update_routine:'按版本修改固定项目，本机审核后应用。',lifeos_delete_routine:'归档固定项目，保留既有计时历史，本机审核。',
 lifeos_create_module:'新增白板业务模块，支持类型、字段及布局。',lifeos_update_module:'按版本修改模块名称、字段、布局或归档状态；不清空记录。',
 lifeos_create_history:'补录已完成的历史计时，必须指定已有固定项目或计划、真实起止时间和IANA时区；扣除暂停，有效不超过30秒不会进入历史。',lifeos_update_history:'按版本修改已结束的历史记录及备注；不覆盖正在进行的计时，需本机审核。',lifeos_delete_history:'将已结束计时移入回收站；本机审核。',
 lifeos_set_routine_completion:'设置某固定项目某日完成状态；已存在时须expected_version，本机审核。',
 lifeos_control_timer:'请求开始/暂停/继续/结束计时；开始指定项目及项目版本，其余指定会话及会话版本。本机审核；queued不是正在计时，应用后查询命令状态。',
 lifeos_list_attachments:'列出授权记录的附件/录音及云端文件就绪状态；不代表已理解音频内容。',
 lifeos_read_attachment:'读取已上传附件的校验数据块，或请求MCP二进制资源/音频内容。客户端是否能理解音频必须实测，不能把文件可读误称已转写；录音未上传时应等待PWA前台补传。'
}
