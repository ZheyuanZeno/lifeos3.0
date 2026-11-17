import {AutoSyncController} from './auto-controller'
import {decryptRecovery} from './identity'
const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
export class AutoSyncUI {
 private message=''
 private working=false
 private pairing=''
 private expanded=false
 private sourceConfirmed=false
 private spaceDraft=''
 private labelDraft=''
 private approvalDraft=''
 private desktopSpace=''
 private grantOwner=false
 constructor(readonly controller:AutoSyncController){}
 async loadDesktop(){if(!['127.0.0.1','localhost'].includes(location.hostname))return;try{const response=await fetch('/api/archive/status',{cache:'no-store'}),value=await response.json();if(value.connection?.space_id){this.desktopSpace=value.connection.space_id;if(!this.spaceDraft)this.spaceDraft=this.desktopSpace;this.mount()}}catch{}}
 mount(){
  const root=document.getElementById('auto-sync');if(!root||root.contains(document.activeElement)&&['INPUT','TEXTAREA'].includes(document.activeElement?.tagName??''))return
  const prior=root.querySelector('details');if(prior)this.expanded=prior.open
  const s=this.controller.state,cloud=s.cloud
  root.innerHTML='<h2>自动同步</h2><p role="status">'+(s.working?'同步中':s.active?'已启用':s.bound?'迁移校验中':'尚未绑定')+'</p>'+(s.error?'<p class="error-text">'+escape(s.error)+'</p>':'')+(s.bound?'<p class="meta">待上传 '+s.pending+' · 待电脑归档 '+(cloud?.unarchived_batches??'—')+'</p>'+(s.lastSuccessAt?'<p class="meta">上次同步 '+escape(new Date(s.lastSuccessAt).toLocaleString())+'</p>':'')+(cloud?.archive?'<p class="meta">电脑归档 '+cloud.archive.cursor+'/'+cloud.head+(cloud.archive.last_success?' · '+escape(new Date(cloud.archive.last_success).toLocaleString()):'')+'</p>':'')+'<div class="inline"><button data-auto="retry">'+(s.active?'重试同步':'上传并核对历史')+'</button><button data-auto="status">刷新状态</button></div><details '+(this.expanded?'open':'')+'><summary>迁移与设备管理</summary><p class="meta device">空间 '+escape(this.controller.transport?.identity.spaceId)+'</p><label><input id="sync-source-confirm" type="checkbox" '+(this.sourceConfirmed?'checked':'')+'>已完成最后一次 Google Drive 同步，并确认历史及媒体完整</label><div class="inline"><button data-auto="verify">下载备份并校验本机</button><button data-auto="activate">正式切换</button><button data-auto="disconnect">解除本设备绑定</button></div><label>新设备配对信息<textarea id="sync-approval" rows="3">'+escape(this.approvalDraft)+'</textarea></label><button data-auto="approve">批准新设备</button>'+(cloud?.devices??[]).filter(d=>!d.revoked).map(d=>'<div class="archive-row"><span>'+escape(d.label)+' · '+escape(d.kind)+'</span>'+(d.id!==this.controller.transport?.identity.deviceId?'<button data-auto="revoke" data-device="'+escape(d.id)+'">撤销</button>':'')+'</div>').join('')+'</details>':'<form id="sync-pair"><label>同步空间编号<input name="space" required pattern="[a-f0-9]{64}" autocomplete="off" value="'+escape(this.spaceDraft)+'"></label><label>本设备名称<input name="label" required maxlength="80" value="'+escape(this.labelDraft||navigator.platform)+'"></label><button type="submit">申请设备配对</button></form><button data-auto="claim">已在电脑批准，完成绑定</button>')+(this.pairing?'<label>将以下信息交给已绑定的电脑或管理设备<textarea readonly rows="4">'+escape(this.pairing)+'</textarea></label>':'')+'<p class="meta" role="status">'+escape(this.message)+'</p>'
  if(!s.bound){const section=document.createElement('details');section.innerHTML='<summary>使用恢复文件</summary><form id="sync-recovery"><label>加密恢复文件<input name="file" type="file" required accept=".json,application/json"></label><label>恢复文件密码<input name="password" type="password" required minlength="12" autocomplete="off"></label><button>恢复设备连接</button></form>';root.append(section);section.querySelector('form')!.addEventListener('submit',e=>{e.preventDefault();const form=new FormData(e.target as HTMLFormElement),file=form.get('file') as File,password=String(form.get('password')??'');void this.run(async()=>{if(!file||file.size>10000)throw Error('恢复文件格式无效');const recovery=await decryptRecovery(JSON.parse(await file.text()),password);await this.controller.recover(recovery.spaceId,recovery.recovery,navigator.platform);this.message='已恢复独立设备身份'})})}
  if(this.desktopSpace){const section=document.createElement('details');section.innerHTML='<summary>Windows 归档管理</summary><p class="meta device">空间 '+escape(this.desktopSpace)+'</p><label>本机批准的配对信息<textarea id="archive-pair" rows="3">'+escape(this.approvalDraft)+'</textarea></label><label><input id="archive-owner" type="checkbox" '+(this.grantOwner?'checked':'')+'>授予空间管理权限</label><button id="archive-approve">在本机批准设备</button>';root.append(section);section.querySelector('textarea')!.addEventListener('input',e=>this.approvalDraft=(e.target as HTMLTextAreaElement).value);section.querySelector('input')!.addEventListener('change',e=>this.grantOwner=(e.target as HTMLInputElement).checked);section.querySelector('button')!.addEventListener('click',e=>{e.stopPropagation();const raw=section.querySelector('textarea')!.value,grant_owner=this.grantOwner;void this.run(async()=>{const pair=JSON.parse(raw);if(!confirm('批准指纹 '+pair.fingerprint+(grant_owner?' 并授予管理权限？':' 的设备读取同步历史？')))return;const state=await(await fetch('/api/state',{cache:'no-store'})).json(),response=await fetch('/api/archive/approve',{method:'POST',headers:{'Content-Type':'application/json','X-LifeOS-Token':state.token},body:JSON.stringify({...pair,grant_owner})}),result=await response.json();if(!response.ok)throw Error(result.error??'批准失败');this.message='已批准，请在新设备完成绑定'})})}
  root.querySelector('details')?.addEventListener('toggle',e=>{this.expanded=(e.target as HTMLDetailsElement).open})
  root.querySelector<HTMLInputElement>('#sync-source-confirm')?.addEventListener('change',e=>{this.sourceConfirmed=(e.target as HTMLInputElement).checked})
  root.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=this.working||s.working)
  root.querySelector<HTMLInputElement>('[name=space]')?.addEventListener('input',e=>{this.spaceDraft=(e.target as HTMLInputElement).value})
  root.querySelector<HTMLInputElement>('[name=label]')?.addEventListener('input',e=>{this.labelDraft=(e.target as HTMLInputElement).value})
  root.querySelector<HTMLTextAreaElement>('#sync-approval')?.addEventListener('input',e=>{this.approvalDraft=(e.target as HTMLTextAreaElement).value})
  root.querySelector('#sync-pair')?.addEventListener('submit',e=>{e.preventDefault();const form=new FormData(e.target as HTMLFormElement);void this.run(async()=>{this.pairing=JSON.stringify(await this.controller.requestPair(String(form.get('space')).trim(),String(form.get('label')).trim()));this.message='配对申请10分钟内有效，请核对设备指纹'})})
  root.querySelectorAll<HTMLButtonElement>('[data-auto]').forEach(button=>button.addEventListener('click',e=>{e.stopPropagation();const action=button.dataset.auto,value=root.querySelector<HTMLTextAreaElement>('#sync-approval')?.value,confirmed=root.querySelector<HTMLInputElement>('#sync-source-confirm')?.checked;void this.run(async()=>{
   if(action==='retry')await this.controller.syncNow()
   if(action==='status')await this.controller.refreshStatus()
   if(action==='claim'){await this.controller.claimPair();this.pairing=''}
   if(action==='approve'){const pair=JSON.parse(value??'');if(!confirm('批准指纹 '+pair.fingerprint+' 的新设备读取全部同步历史？'))return;await this.controller.approvePair(pair)}
   if(action==='verify'){await this.controller.verifyMigration(confirmed===true,async backup=>{const url=URL.createObjectURL(new Blob([JSON.stringify(backup)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='lifeos-migration-backup-'+new Date().toISOString().slice(0,10)+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),60000)});this.message='本机清单已核验。正式切换仍需电脑归档和另一台PWA核验'}
   if(action==='disconnect'&&confirm('撤销本设备的同步身份？所有本地记录和录音都会保留。')){await this.controller.disconnect();this.message='已撤销设备身份，本地业务数据保留'}
   if(action==='activate'){await this.controller.activate();this.message='自动同步已启用'}
   if(action==='revoke'&&confirm('撤销此设备的同步权限？本机历史不会删除。'))await this.controller.transport!.request('device/revoke',{device_id:button.dataset.device})
  })}))
 }
 private async run(action:()=>Promise<void>){if(this.working)return;this.working=true;this.message='';this.mount();try{await action()}catch(e){this.message=e instanceof Error?e.message:'操作失败'}finally{this.working=false;this.mount()}}
}
