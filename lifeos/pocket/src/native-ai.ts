import type {PocketDatabase} from './database'
import {getIdentity} from './repository'
import {snapshot} from './ai/context'
import {preview,execute,type Preview} from './ai/executor'
import {dayAt} from './time'
import {dailyProjection} from './native-daily'
const base='/api/mcp-device/',url='https://lifeos-mcp.lifeos-pocket.workers.dev/mcp'
const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';')
interface Policy {from:string;to:string;time_zone:string;notes:boolean;modify:boolean;daily?:boolean}
interface Credential {token:string;accountId:string;policy:Policy}
export class NativeAI {
 private credential?:Credential;private draft?:Policy;private running=false;private status='未连接';private pair='';private review:{id:string;p:Preview}[]=[]
 private recent:unknown[]=[]
 constructor(private db:PocketDatabase,private google:()=>string,private account:()=>string|undefined,private changed:()=>void,private ready:()=>boolean,private published:()=>Promise<boolean>){
  void db.local.get('native-ai').then(r=>{this.credential=r?.value as Credential|undefined;this.render();void this.tick()}).catch(()=>{})
  document.addEventListener('click',e=>{const b=(e.target as HTMLElement).closest<HTMLButtonElement>('[data-native]');if(b)void this.action(b.dataset.native!,b.dataset.id)})
  document.addEventListener('change',e=>{if((e.target as HTMLElement).matches('#native-from,#native-to,#native-notes,#native-modify,#native-daily')){this.draft=this.readPolicy();this.render()}})
  window.addEventListener('online',()=>void this.tick());document.addEventListener('visibilitychange',()=>void this.tick());setInterval(()=>void this.tick(),30000)
 }
 mount(){this.render()}
 wake(){setTimeout(()=>void this.tick(),500)}
 private async acknowledge(id:string,command:any){const needs=command.operations.some((o:any)=>o.action==='complete_plan'||o.action==='update_plan'||o.data?.planned_start);const confirmed=needs&&await this.published();await this.api('ack',{command_id:id,status:'applied',reminder_status:!needs?'not_requested':confirmed?'backend_confirmed':'pending_backend_confirmation'});if(needs&&!confirmed)await this.db.local.put({key:'native-reminder:'+id,value:true})}
 private render(){const root=document.querySelector('#native-ai');if(!root)return;const p=this.draft??this.credential?.policy;root.innerHTML='<h2>原生 AI 连接</h2><p role="status">'+esc(this.status)+(this.draft?'；权限修改尚未保存，请点击下方绑定按钮':'')+'</p><p class="meta">'+esc(url)+'</p><button data-native="copy">复制连接器地址</button><label>允许查询起始日期<input id="native-from" type="date" value="'+(p?.from??dayAt())+'"></label><label>允许查询结束日期<input id="native-to" type="date" value="'+(p?.to??dayAt(Date.now()+30*86400000))+'"></label><label><input id="native-notes" type="checkbox" '+(p?.notes?'checked':'')+'>允许 AI 读取和管理随手记（含正文）</label><label><input id="native-daily" type="checkbox" '+(p?.daily?'checked':'')+'>允许 AI 读取当日记录（计时及备注）</label><label><input id="native-modify" type="checkbox" '+(p?.modify?'checked':'')+'>允许修改/完成（仍需在本机审核）</label><div class="inline"><button data-native="connect">绑定设备并生成配对码</button><button data-native="revoke">解除全部原生 AI 授权</button></div>'+(this.pair?'<p>配对码（5 分钟、仅一次）：</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere">'+esc(this.pair)+'</pre><button data-native="copy-pair">复制配对码</button>':'')+'<details><summary>最近 AI 操作</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">'+esc(JSON.stringify(this.recent,null,2))+'</pre></details>'+this.review.map(r=>'<details open><summary>待审核 '+esc(r.id)+'</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto">'+esc(JSON.stringify(r.p.rows,null,2))+'</pre><button data-native="apply" data-id="'+esc(r.id)+'">确认应用</button></details>').join('');root.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=this.running)}
 private async api(action:string,data:unknown,token=this.credential?.token){if(!token)throw Error('请先绑定设备');const r=await fetch(base+action,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(20000)});const result=await r.json();if(r.status===401&&action!=='enroll'){this.credential=undefined;this.pair='';await this.db.local.delete('native-ai')};if(!r.ok)throw Error(result.error??'原生 AI 服务失败');return result}
 private readPolicy():Policy{return {from:(document.querySelector('#native-from') as HTMLInputElement).value,to:(document.querySelector('#native-to') as HTMLInputElement).value,time_zone:Intl.DateTimeFormat().resolvedOptions().timeZone,notes:(document.querySelector('#native-notes') as HTMLInputElement).checked,modify:(document.querySelector('#native-modify') as HTMLInputElement).checked,daily:(document.querySelector('#native-daily') as HTMLInputElement).checked}}
 private async action(action:string,id?:string){if(this.running)return;if(action==='copy'||action==='copy-pair'){await navigator.clipboard.writeText(action==='copy'?url:this.pair);return}if(this.credential&&this.account()&&this.account()!==this.credential.accountId&&action!=='revoke'){this.status='账号已切换，请先撤销原账号授权，再明确绑定新账号';this.render();return}
  const policy=this.readPolicy()
  this.running=true;this.render();try{
   if(action==='connect'){if(!this.credential||JSON.stringify(this.credential.policy)!==JSON.stringify(policy)){const result=await this.api('enroll',{device:(await getIdentity(this.db)).id,policy},this.google());this.credential={...result,policy};this.draft=undefined;await this.db.local.put({key:'native-ai',value:this.credential})};const pair=await this.api('pair',{});this.draft=undefined;this.pair=this.credential!.token.split('.')[0]+'.'+pair.secret;this.status='权限已保存到设备；请用此配对码重新授权聊天连接，并在授权页勾选需要的随手记/当日记录/修改权限'}
   else if(action==='revoke'){if(!confirm('撤销全部原生 AI 客户端和设备授权？'))return;await this.api('revoke',{});this.credential=undefined;this.draft=undefined;this.pair='';this.review=[];await this.db.local.delete('native-ai');this.status='授权已撤销'}
   else if(action==='apply'){const r=this.review.find(r=>r.id===id);if(r){await execute(await preview(r.p.command,this.db),this.db);this.changed();await this.acknowledge(r.id,r.p.command);this.review=this.review.filter(r=>r.id!==id);this.status='已应用；提醒后台及手机收件状态需分别核实'}}
  }catch(e){this.status=String(e)}finally{this.running=false;this.render();if(action==='connect')void this.tick()}}
 private async tick(){if(!this.ready()||this.running||!this.credential||!navigator.onLine||document.visibilityState!=='visible')return;if(this.account()&&this.account()!==this.credential.accountId){this.status='账号切换，原生 AI 已停止，请重新绑定';this.render();return}
  this.running=true;this.render();try{
   const policy=this.credential.policy,raw=JSON.parse(await snapshot(this.db,{from:policy.from,to:policy.to,notes:policy.notes,body:policy.notes,stats:false,status:'all'},'Google Drive 仍为手动同步'))
   const rows=raw.records.map((r:any)=>{const {updated_at,module_id,...row}=r;if(row.type==='task')delete row.body;return row})
   let dailyRows:Awaited<ReturnType<typeof dailyProjection>>=[],dailyWarning='';if(policy.daily)try{dailyRows=await dailyProjection(await this.db.sessions.toArray(),policy.from,policy.to);if(new TextEncoder().encode(JSON.stringify({rows,daily_rows:dailyRows})).length>250000)throw Error('当日记录投影过大，请缩小日期范围；历史未上传')}catch(e){dailyRows=[];dailyWarning=String(e)}
   await this.api('projection',{rows,daily_rows:dailyRows,daily_warning:dailyWarning,sync:'仅本机已保存记录；其他设备可能尚未手动同步'})
   if(await this.published())for(const receipt of await this.db.local.where('key').startsWith('native-reminder:').toArray()){await this.api('ack',{command_id:receipt.key.slice('native-reminder:'.length),status:'applied',reminder_status:'backend_confirmed'});await this.db.local.delete(receipt.key)}
   const pending=await this.api('pending',{});this.review=[];this.recent=pending.recent??[]
   for(const entry of pending.commands){const p=await preview(entry.command,this.db);if(await this.db.local.get('ai-result:'+entry.command_id)){await this.acknowledge(entry.command_id,entry.command);continue}if(p.rows.some(r=>r.status==='conflict')){await this.api('ack',{command_id:entry.command_id,status:'conflict',error:p.rows.filter(r=>r.status==='conflict').map(r=>r.reason).join('；')});continue}if(entry.review){this.review.push({id:entry.command_id,p});continue}try{await execute(p,this.db)}catch(e){await this.api('ack',{command_id:entry.command_id,status:'failed',error:String(e)});continue}this.changed();await this.acknowledge(entry.command_id,entry.command)}
   this.status='已连接；待审核 '+this.review.length+' 项'+(dailyWarning?'；'+dailyWarning:'')+'；设备仅前台联网时自动领取'
  }catch(e){this.status='原生 AI 待重试：'+String(e)}finally{this.running=false;this.render()}}
}
