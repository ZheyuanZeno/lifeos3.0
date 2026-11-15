import {z} from 'zod'
import {canonical,digest,validDate} from './util'
import {toolSchemas,toCommand,type Tool,scopes} from './contracts'
export const policySchema=z.object({from:z.string(),to:z.string(),time_zone:z.string(),notes:z.boolean(),modify:z.boolean()}).strict()
export const projected=z.object({id:z.string().max(100),type:z.enum(['task','note']),title:z.string().max(200),date:z.string(),status:z.enum(['todo','done']),source_id:z.string().max(300),updated_version:z.string().regex(/^[a-f0-9]{64}$/),deadline:z.string().max(10),planned_start:z.string().max(40),time_zone:z.string().max(100),body:z.string().max(10000).optional()}).strict()
export class LifeOSHub {
 constructor(private ctx:DurableObjectState){ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY,value TEXT NOT NULL)')}
 async fetch(r:Request){return this.ctx.blockConcurrencyWhile(async()=>{try{
  const input=await r.json() as any,stored=new Map(this.ctx.storage.sql.exec<{key:string;value:string}>('SELECT key,value FROM state').toArray().map(r=>[r.key,r.value]));let state:any={epoch:crypto.randomUUID(),devices:{},commands:{},pairs:{},rate:{at:0,count:0},...(stored.has('meta')?JSON.parse(stored.get('meta')!):{})}
  for(const [key,value] of stored)if(key.startsWith('device:'))state.devices[key.slice(7)]=JSON.parse(value);else if(key.startsWith('command:'))state.commands[key.slice(8)]=JSON.parse(value)
  const path=new URL(r.url).pathname,now=Date.now();const save=()=>this.ctx.storage.transactionSync(()=>{const values=new Map<string,string>([['meta',JSON.stringify({epoch:state.epoch,pairs:state.pairs,rate:state.rate})]]);for(const [id,value] of Object.entries(state.devices))values.set('device:'+id,JSON.stringify(value));for(const [id,value] of Object.entries(state.commands))values.set('command:'+id,JSON.stringify(value));for(const [key,value] of values)if(stored.get(key)!==value)this.ctx.storage.sql.exec('INSERT OR REPLACE INTO state VALUES (?,?)',key,value);for(const key of stored.keys())if(!values.has(key))this.ctx.storage.sql.exec('DELETE FROM state WHERE key=?',key)})
  if(path==='/gate'){const rate=await this.ctx.storage.get<{at:number;count:number}>('gate')??{at:now,count:0};if(now-rate.at>60000){rate.at=now;rate.count=0}rate.count++;await this.ctx.storage.put('gate',rate);return Response.json({allowed:rate.count<=120})}
  if(path==='/enroll'){
   const policy=policySchema.parse(input.policy);if(!validDate(policy.from)||!validDate(policy.to)||policy.from>policy.to||Date.parse(policy.to)-Date.parse(policy.from)>366*86400000)throw Error('授权日期范围无效，最多一年')
   new Intl.DateTimeFormat('en',{timeZone:policy.time_zone})
   if(state.devices[input.device]&&canonical(state.devices[input.device].policy)!==canonical(policy)){state.epoch=crypto.randomUUID();state.pairs={};for(const c of Object.values(state.commands) as any[])if(['queued','review'].includes(c.status)){c.status='failed';c.receipts={policy_change:{status:'failed',error:'授权范围已变更，请重新授权后提交'}}}}
   if(Object.keys(state.devices).length>=20&&!state.devices[input.device])throw Error('设备上限20')
   const secret=crypto.randomUUID()+crypto.randomUUID();state.devices[input.device]={hash:await digest(secret),expires:now+365*86400000,policy,projection:[],updated:0,sync:'unknown'};await save();return Response.json({secret,epoch:state.epoch})
  }
  if(path==='/redeem'){
   const key=await digest(input.secret),pair=state.pairs[key];if(!pair||pair.expires<now)throw Error('配对码已失效或已使用');delete state.pairs[key];await save();return Response.json({epoch:state.epoch,scopes:pair.scopes,policy:pair.policy})
  }
  let device:any
  if(input.device){device=state.devices[input.device];if(!device||device.expires<now||device.hash!==await digest(input.secret))return Response.json({error:'设备凭证失效，请重新配对'},{status:401})}
  else if(input.epoch!==state.epoch)return Response.json({error:'授权已撤销'},{status:401})
  if(now-state.rate.at>60000)state.rate={at:now,count:0};if(++state.rate.count>120)return Response.json({error:'请求过于频繁'},{status:429})
  const deviceAllows=(c:any)=>c.command.operations.every((o:any)=>{const target=o.target_id?device?.projection.find((r:any)=>r.id===o.target_id):undefined;if(o.target_id&&!target)return false;const date=o.data?.date??target?.date;return (!o.action.endsWith('note')||device.policy.notes)&&(!o.action.startsWith('update')&&o.action!=='complete_plan'||device.policy.modify)&&(!date||date>=device.policy.from&&date<=device.policy.to)})
  let result:any
  if(path==='/pair'&&device){for(const [key,p] of Object.entries(state.pairs) as [string,any][])if(p.expires<now)delete state.pairs[key];if(Object.keys(state.pairs).length>=20)throw Error('配对码过多，请等待过期');const secret=crypto.randomUUID()+crypto.randomUUID();const granted=['lifeos:read','lifeos:create','offline_access',...(device.policy.modify?['lifeos:modify']:[]),...(device.policy.notes?['lifeos:notes']:[])];state.pairs[await digest(secret)]={expires:now+300000,scopes:granted,policy:device.policy};result={secret,expires:now+300000}}
  else if(path==='/revoke'&&device){state={epoch:crypto.randomUUID(),devices:{},commands:{},pairs:{},rate:{at:now,count:0}};result={revoked:true}}
  else if(path==='/projection'&&device){const rows=z.array(projected).max(200).parse(input.rows);for(const row of rows){if(row.date<device.policy.from||row.date>device.policy.to||row.type==='note'&&!device.policy.notes)throw Error('投影超出授权范围');if(row.type==='task'&&row.body!==undefined)throw Error('计划正文不允许默认上传')};device.projection=rows;device.updated=now;device.sync=String(input.sync).slice(0,200);result={updated_at:now}}
  else if(path==='/pending'&&device){const allowed=(Object.values(state.commands) as any[]).filter(deviceAllows);result={commands:allowed.filter(c=>['queued','review'].includes(c.status)).slice(0,5),recent:allowed.slice(-10).map(c=>({command_id:c.command_id,status:c.status,reminder_status:c.reminder_status,receipts:c.receipts}))}}
  else if(path==='/ack'&&device){const c=state.commands[input.command_id];if(!c)throw Error('命令不存在');if(!deviceAllows(c))throw Error('设备没有此命令的权限');const status=z.enum(['applied','conflict','failed','review']).parse(input.status);c.receipts??={};c.receipts[input.device]={status,at:now,error:String(input.error??'').slice(0,500)};if(c.status!=='applied')c.status=status;if(status==='applied'&&input.reminder_status&&c.reminder_status!=='backend_confirmed')c.reminder_status=z.enum(['not_requested','pending_backend_confirmation','backend_confirmed']).parse(input.reminder_status);result=c}
  else if(path==='/tool'){
   const name=input.name as Tool;if(!Object.hasOwn(toolSchemas,name))throw Error('未知工具');const args=toolSchemas[name].parse(input.args) as any,granted=input.scopes as string[]
   if(['__proto__','prototype','constructor'].includes(args.command_id))throw Error('命令编号无效')
   if(!granted.includes('lifeos:read'))throw Error('缺少只读授权');if(name.includes('note')&&!granted.includes('lifeos:notes'))throw Error('笔记未授权')
   const policy=policySchema.parse(input.policy),devices=(Object.values(state.devices) as any[]).filter(d=>d.expires>now),rows=new Map<string,any>();for(const d of devices)for(const row of d.projection){if(row.date<policy.from||row.date>policy.to||row.type==='note'&&!granted.includes('lifeos:notes'))continue;const old=rows.get(row.id);rows.set(row.id,old&&old.updated_version!==row.updated_version?{...old,conflict:true}:old??row)}
   const freshness={devices:devices.map(d=>({updated_at:d.updated,sync:d.sync})),warning:'仅来自前台设备的授权投影，未手动同步的其他设备可能有更新',time_zone:policy.time_zone,allowed_range:{from:policy.from,to:policy.to},phone_delivery:'not_verified_by_mcp',current_time:new Date(now).toISOString()}
   if(name==='lifeos_get_status')result={...freshness,pending:Object.values(state.commands).filter((c:any)=>['queued','review'].includes(c.status)).length,conflicts:Object.values(state.commands).filter((c:any)=>c.status==='conflict').length,failed:Object.values(state.commands).filter((c:any)=>c.status==='failed').length,reminders:'目前仅计划开始时提醒，不支持提前提醒',current_date:new Intl.DateTimeFormat('en-CA',{timeZone:freshness.time_zone}).format(now)}
   else if(name==='lifeos_get_command_status'){const c=state.commands[args.command_id];result={command:c?{command_id:c.command_id,status:c.status,created_at:c.created_at,reminder_status:c.reminder_status,receipts:c.receipts}:null,...freshness}}
   else if(name==='lifeos_get_plan'){const row=rows.get(args.id);result={plan:row?.type==='task'?row:null,...freshness}}
   else if(name.startsWith('lifeos_list_')){if(!validDate(args.from)||!validDate(args.to)||args.from>args.to)throw Error('日期范围无效');const list=[...rows.values()].filter(row=>row.type===(name.endsWith('notes')?'note':'task')&&row.date>=args.from&&row.date<=args.to).sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));result={items:list.slice(args.offset,args.offset+args.limit),next_offset:args.offset+args.limit<list.length?args.offset+args.limit:null,...freshness}}
   else {
    const modifying=name.includes('update')||name.includes('complete');if(!granted.includes(modifying?'lifeos:modify':'lifeos:create'))throw Error('缺少写入权限')
    const hash=await digest([name,args]),existing=state.commands[args.command_id];if(existing){if(existing.hash!==hash)throw Error('command_id 内容冲突');result=existing}
    else {
     if(Object.keys(state.commands).length>=200)throw Error('队列达到200条上限，请先处理并归档')
     if(modifying){const target=rows.get(args.id);if(!target||target.conflict||target.updated_version!==args.expected_version)return Response.json({status:'conflict',reason:'目标版本过期或设备投影冲突'})}
     const command=toCommand(name,args),review=modifying||command.operations.length>10;for(const op of command.operations){if(op.action==='batch_import')throw Error('不支持嵌套批次');const date=op.data.date;if(date&&(date<policy.from||date>policy.to))throw Error('写入日期超出授权范围')};if(new TextEncoder().encode(JSON.stringify(command)).byteLength>65536)throw Error('单命令超过64KB，请拆分批次')
     result={command_id:args.command_id,hash,command,status:review?'review':'queued',review,created_at:now,reminder_status:'not_confirmed',message:'queued/review 不是已写入设备；applied 也不等于手机已收到通知'};state.commands[args.command_id]=result
    }
   }
  }else throw Error('不支持的设备操作')
  await save();return Response.json(result)
 }catch(e){return Response.json({error:e instanceof Error?e.message:'请求失败'},{status:400})}})}
}
