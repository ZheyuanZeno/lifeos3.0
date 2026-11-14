const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const templates = {
 journal:{name:'每日记录',type:'journal',icon:'▱',view:'list',fields:[]},
 health:{name:'健康记录',type:'activity',icon:'♡',view:'table',fields:[{id:'duration',name:'时长（分钟）',type:'number'}]},
 shopping:{name:'购物记录',type:'expense',icon:'▤',view:'table',fields:[{id:'merchant',name:'商家',type:'text'}]},
 plans:{name:'计划',type:'task',icon:'☑',view:'list',fields:[]},
 custom:{name:'新的模块',type:'note',icon:'▦',view:'table',fields:[]}
};
let state, page='board', query='', editingModule=null, moduleFields=[], editingRecord=null, attachments=[], busy=false, uploading=false, timer;
const expanded = new Set();
const today = () => {const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const modules = () => state.modules.filter(m=>!m.archived);
const moduleFor = id => state.modules.find(m=>m.id===id);
const moduleRecords = id => state.records.filter(r=>r.module_id===id&&!r.deleted).sort((a,b)=>moduleFor(id).kind==='plans'?a.date.localeCompare(b.date):b.date.localeCompare(a.date));
const clone = obj => structuredClone(obj);
function toast(text){clearTimeout(timer);$('#toast').textContent=text;$('#toast').hidden=false;timer=setTimeout(()=>$('#toast').hidden=true,4500);}
async function api(path,payload){const res=await fetch(path,payload===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-LifeOS-Token':state.token},body:JSON.stringify(payload)});const body=await res.json();if(!res.ok)throw new Error(body.error||'操作未完成');return body;}
async function refresh(){state=await api('/api/state');render();}
async function mutate(path,payload){const result=await api(path,{...payload,expected_revision:state.updated_at});await refresh();return result;}
function taskLabel(r){return `<div class="check-title ${r.status==='done'?'done':''}"><input class="task-check" type="checkbox" data-check="${esc(r.id)}" aria-label="计划：${esc(r.title)}" ${r.status==='done'?'checked':''}><button type="button" class="row-title" data-record="${esc(r.id)}">${esc(r.title)}</button></div>`;}
function titleCell(r){return r.type==='task'?taskLabel(r):`<button type="button" class="row-title" data-record="${esc(r.id)}">${esc(r.title)}</button>`;}
function valueCell(value){return value?esc(value):'<span class="muted">—</span>';}
function amount(r){return r.amount===null?'<span class="muted">待补</span>':`${esc(r.amount)} ${esc(r.currency)}`;}
function renderTable(m,rows){return `<div class="table-wrap"><table class="database-table"><thead><tr><th>名称</th><th>日期</th>${m.kind==='shopping'?'<th>金额</th>':''}${m.fields.map(f=>`<th>${esc(f.name)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr><td>${titleCell(r)}</td><td class="date-cell">${esc(r.date)}</td>${m.kind==='shopping'?`<td>${amount(r)}</td>`:''}${m.fields.map(f=>`<td>${valueCell(r.properties[f.id])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;}
function renderList(m,rows){return `<div class="database-list">${rows.map(r=>`<div class="list-row"><div class="list-topline">${titleCell(r)}<time>${esc(r.date)}</time></div>${r.body?`<p class="list-summary">${esc(r.body)}</p>`:''}${m.kind==='shopping'?`<div class="list-properties">${amount(r)}</div>`:''}${m.fields.some(f=>r.properties[f.id])?`<p class="list-properties">${m.fields.filter(f=>r.properties[f.id]).map(f=>`${esc(f.name)}：${esc(r.properties[f.id])}`).join(' · ')}</p>`:''}</div>`).join('')}</div>`;}
function layoutFor(m){const i=modules().findIndex(x=>x.id===m.id);return m.layout||{x:70+(i%2)*530,y:85+Math.floor(i/2)*350,width:460,height:300};}
function database(m){const rows=moduleRecords(m.id);const p=layoutFor(m);return `<section class="database-block" id="${esc(m.id)}" data-module="${esc(m.id)}" style="left:${p.x}px;top:${p.y}px;width:${p.width}px;height:${p.height}px"><div class="module-header" tabindex="0" aria-label="拖动${esc(m.name)}，也可用方向键移动"><h2>${esc(m.name)}</h2><div class="module-tools"><button class="module-add" data-new-record="${esc(m.id)}" aria-label="向${esc(m.name)}添加记录">+</button><details class="module-menu"><summary aria-label="${esc(m.name)}的设置与属性">...</summary><div class="menu-content"><button data-edit-module="${esc(m.id)}">设置与属性</button><button data-view-module="${esc(m.id)}">切换${m.view==='table'?'列表':'表格'}</button><div class="menu-divider"></div><a href="/api/export?module=${esc(m.id)}&format=zip">导出此模块</a><a href="/api/export?module=${esc(m.id)}&format=csv">导出 CSV</a><button data-page="data">白板数据与导出</button><button data-archive-module="${esc(m.id)}">删除模块</button></div></details></div></div><div class="module-content">${m.view==='table'?renderTable(m,rows):renderList(m,rows)}</div><span class="resize-handle" data-resize="${esc(m.id)}" aria-label="调整${esc(m.name)}大小"></span></section>`;}
function boardView(){return modules().map(database).join('');}
function exportsView(){return `<h1 class="page-heading">数据与导出</h1><div class="export-row"><div><h3>带走整个白板</h3><p>包含模块、属性、记录和原始附件。也包含 HTML 阅读版、Markdown 和各模块的 CSV。</p></div><a class="primary" href="/api/export?format=zip">完整备份 ZIP ↓</a></div><div class="export-row"><div><h3>在其他地方阅读</h3><p>文字和图片包含在一个文件里，用浏览器即可打开。</p></div><a class="quiet" href="/api/export?format=html">阅读版 HTML ↓</a></div><div class="export-row"><div><h3>原始数据</h3><p>导出模块定义和全部记录。JSON 不包含附件内容。</p></div><a class="quiet" href="/api/export?format=json">导出 JSON ↓</a></div><div class="export-row"><div><h3>导入备份或整理结果</h3><p>可以新增模块并填入记录，也能恢复已有备份。</p></div><button class="quiet" id="open-import">导入 ↗</button></div><div class="export-row"><div><h3>撤销与恢复</h3><p>最近一次新增、修改或整批导入可以撤销。移除的模块和记录可在回收站找回。</p></div><button class="quiet" id="undo" ${state.can_undo?'':'disabled'}>撤销上一次修改</button></div><button class="quiet" data-page="trash">打开回收站</button><p class="data-info">资料目录：${esc(state.data_path)}<br>完整记录存于本机 SQLite 数据库；JSON 与 Markdown 是同步生成的导出副本。</p><button class="quiet" data-page="board">← 回到白板</button>`;}
function trashView(){const archived=state.modules.filter(m=>m.archived);const deleted=state.records.filter(r=>r.deleted);return `<h1 class="page-heading">回收站</h1><p class="hint">这里的内容可以恢复，原始数据仍然保留。</p>${archived.map(m=>`<div class="trash-row"><div>${esc(m.name)} <small>模块</small></div><button class="quiet" data-restore-module="${esc(m.id)}">恢复模块</button></div>`).join('')}${deleted.map(r=>`<div class="trash-row"><div>${esc(r.title)}<br><small>${esc(r.date)} · ${esc(moduleFor(r.module_id)?.name)}</small></div><button class="quiet" data-restore-record="${esc(r.id)}">恢复记录</button></div>`).join('')}${!archived.length&&!deleted.length?'<p class="hint">回收站是空的。</p>':''}<button class="quiet" data-page="board">← 回到白板</button>`;}
function render(){
 $('#workspace').innerHTML=boardView();applyCamera();
 if(page!=='board')$('#utility-content').innerHTML=page==='data'?exportsView():trashView();
}
function changePage(value){page=value;render();if(value==='board')$('#utility-dialog').close();else if(!$('#utility-dialog').open)$('#utility-dialog').showModal();}
function renderFields(){ $('#field-list').innerHTML=moduleFields.map((f,i)=>`<div class="property-row"><input aria-label="属性 ${i+1} 名称" data-field-index="${i}" data-key="name" value="${esc(f.name)}" required maxlength="60"><select aria-label="属性 ${i+1} 类型" data-field-index="${i}" data-key="type">${[['text','文字'],['number','数字'],['date','日期']].map(([v,n])=>`<option value="${v}" ${f.type===v?'selected':''}>${n}</option>`).join('')}</select><button type="button" class="icon-button" data-remove-field="${i}" aria-label="移除属性 ${i+1}">×</button></div>`).join('');}
function openModule(id){editingModule=id?clone(moduleFor(id)):null;const m=editingModule||{...templates.journal,kind:'journal'};$('#module-kind').value=m.kind;$('#module-kind').disabled=!!id;$('#module-name').value=m.name;$('#module-view').value=m.view;moduleFields=clone(m.fields);renderFields();$('#module-heading').textContent=id?'模块设置':'添加一个模块';$('#save-module').textContent=id?'保存':'创建模块';$('#module-error').textContent='';$('#module-dialog').showModal();}
$('#module-kind').addEventListener('change',()=>{const preset=templates[$('#module-kind').value];const names=Object.values(templates).map(x=>x.name);if(!$('#module-name').value||names.includes($('#module-name').value))$('#module-name').value=preset.name;$('#module-view').value=preset.view;moduleFields=clone(preset.fields);renderFields();});
$('#add-field').addEventListener('click',()=>{if(moduleFields.length>=30)return toast('每个模块最多 30 个属性');moduleFields.push({id:'field-'+crypto.randomUUID().replaceAll('-',''),name:'新属性',type:'text'});renderFields();});
$('#field-list').addEventListener('input',e=>{const i=e.target.dataset.fieldIndex;if(i!==undefined)moduleFields[Number(i)][e.target.dataset.key]=e.target.value;});
$('#module-form').addEventListener('submit',async e=>{e.preventDefault();if(busy)return;busy=true;$('#save-module').disabled=true;try{const module={...editingModule,layout:editingModule?.layout||newModuleLayout(),kind:$('#module-kind').value,name:$('#module-name').value,view:$('#module-view').value,fields:moduleFields};await mutate('/api/module',{module});$('#module-dialog').close();changePage('board');toast(editingModule?'模块已更新':'模块已添加，可以开始记录了');}catch(e){$('#module-error').textContent=e.message;}finally{busy=false;$('#save-module').disabled=false;}});
function activeRecordType(){return editingRecord?.type||templates[moduleFor($('#record-module').value).kind].type;}
function recordProperties(values={}){const m=moduleFor($('#record-module').value);const type=activeRecordType();$('#status-label').hidden=type!=='task';$('#amount-label').hidden=type!=='expense';$('#currency-label').hidden=type!=='expense';$('#custom-properties').innerHTML=m.fields.map(f=>`<label>${esc(f.name)}<input data-property="${esc(f.id)}" type="${f.type==='date'?'date':'text'}" ${f.type==='number'?'inputmode="decimal"':''} value="${esc(values[f.id]??'')}" placeholder="留空也可以"></label>`).join('');}
function renderAttachments(){ $('#record-attachments').innerHTML=attachments.map((a,i)=>`<div class="attachment-item"><a href="/attachments/${esc(a.file)}" target="_blank" rel="noopener">${esc(a.name)}</a><button class="quiet" type="button" data-remove-attachment="${i}">移除关联</button></div>${/\.(png|jpg|jpeg|webp|gif)$/i.test(a.file)?`<img class="attachment-image" alt="${esc(a.name)}" src="/attachments/${esc(a.file)}">`: /\.(m4a|mp4|webm|ogg|wav)$/i.test(a.file)?`<audio controls preload="metadata" src="/attachments/${esc(a.file)}" aria-label="${esc(a.name)}"></audio>`:''}`).join('');}
function relatedView(r){if(!r)return '';const linked=state.records.filter(x=>x.source_id===r.id&&!x.deleted&&!moduleFor(x.module_id)?.archived);const source=state.records.find(x=>x.id===r.source_id);return `${linked.length?`<section class="related"><h3>关联的记录</h3>${linked.map(x=>`<div class="related-row"><small>${esc(moduleFor(x.module_id)?.name)} · ${esc(x.date)}</small><div>${x.type==='task'?taskLabel(x):titleCell(x)}</div></div>`).join('')}</section>`:''}${source?`<section class="related"><small class="hint">来自日记</small><div><button type="button" class="row-title" data-record="${esc(source.id)}">${esc(source.title)}</button></div></section>`:''}`;}
function openRecord(id,moduleId){if(uploading)return toast('附件还在上传，请稍候');editingRecord=id?clone(state.records.find(r=>r.id===id)):null;const m=moduleFor(editingRecord?.module_id||moduleId);if(!m)return;const type=editingRecord?.type||templates[m.kind].type;const date=today();const r=editingRecord||{module_id:m.id,title:type==='journal'?`${Number(date.slice(5,7))}.${Number(date.slice(8))} 日记`:'',date,body:'',status:type==='task'?'todo':'done',amount:'',currency:''};const form=$('#record-form');form.reset();$('#record-module').innerHTML=state.modules.filter(x=>!x.archived||x.id===r.module_id).map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');['module_id','title','date','body','status','amount','currency'].forEach(key=>form.elements[key].value=r[key]??'');recordProperties(r.properties);attachments=clone(r.attachments||[]);renderAttachments();$('#record-heading').textContent=m.name;$('#delete-record').hidden=!editingRecord;$('#related-records').innerHTML=relatedView(editingRecord);$('#record-error').textContent='';if(!$('#record-dialog').open)$('#record-dialog').showModal();}
$('#record-module').addEventListener('change',()=>recordProperties(editingRecord?.properties));
async function saveRecord(record,expected){return mutate('/api/save',{record,expected_updated_at:expected});}
$('#record-form').addEventListener('submit',async e=>{e.preventDefault();if(busy||uploading)return;busy=true;$('#save-record').disabled=true;try{const v=Object.fromEntries(new FormData(e.target));const type=activeRecordType();const properties={...editingRecord?.properties};$$('[data-property]').forEach(input=>properties[input.dataset.property]=input.value);const r={...editingRecord,...v,type,properties,attachments};if(type!=='expense'){r.amount=null;r.currency='';}if(type!=='task')r.status='done';await saveRecord(r,editingRecord?.updated_at);$('#record-dialog').close();toast('已保存');}catch(e){$('#record-error').textContent=e.message;}finally{busy=false;$('#save-record').disabled=false;}});
function base64(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('文件读取失败'));reader.readAsDataURL(file);});}
$('#attachment-input').addEventListener('change',async e=>{uploading=true;$('#save-record').disabled=true;try{for(const file of e.target.files){if(file.size>10*1024*1024)throw Error('单个附件最多 10MB');if(attachments.length>=30)throw Error('每条记录最多 30 个附件');attachments.push(await api('/api/attachment',{name:file.name,data:await base64(file)}));renderAttachments();}}catch(e){$('#record-error').textContent=e.message;}finally{uploading=false;$('#save-record').disabled=false;e.target.value='';}});
$('#delete-record').addEventListener('click',async()=>{if(busy||!editingRecord)return;busy=true;try{await saveRecord({...editingRecord,deleted:true},editingRecord.updated_at);$('#record-dialog').close();toast('已移到回收站');}catch(e){$('#record-error').textContent=e.message;}finally{busy=false;}});
async function changeModule(module){await mutate('/api/module',{module});}
document.addEventListener('click',async e=>{
 const button=e.target.closest('button');const link=e.target.closest('[data-module-link]');if(link){page='board';query='';$('#search-area').hidden=true;render();return;}if(!button)return;
 if(button.hasAttribute('data-close')){if(uploading)return toast('附件还在上传，请稍候');button.closest('dialog').close();return;}
 if(button.hasAttribute('data-add-module')){openModule();return;}
 if(button.dataset.page){if($('#module-dialog').open)$('#module-dialog').close();changePage(button.dataset.page);return;}
 if(button.dataset.editModule){openModule(button.dataset.editModule);return;}
 if(button.dataset.newRecord){openRecord(null,button.dataset.newRecord);return;}
 if(button.dataset.record){openRecord(button.dataset.record);return;}
 if(button.dataset.removeField!==undefined){moduleFields.splice(Number(button.dataset.removeField),1);renderFields();return;}
 if(button.dataset.removeAttachment!==undefined){attachments.splice(Number(button.dataset.removeAttachment),1);renderAttachments();return;}
 if(button.dataset.expand){expanded.has(button.dataset.expand)?expanded.delete(button.dataset.expand):expanded.add(button.dataset.expand);render();return;}
 if(button.id==='open-import'){$('#import-error').textContent='';$('#import-dialog').showModal();return;}
 if(busy)return;
 const action=button.dataset.viewModule||button.dataset.move||button.dataset.archiveModule||button.dataset.restoreModule||button.dataset.restoreRecord||button.id==='undo';if(!action)return;busy=true;
 try{
  if(button.dataset.viewModule){const m=moduleFor(button.dataset.viewModule);await changeModule({...m,view:m.view==='table'?'list':'table'});}
  if(button.dataset.move){const id=button.dataset.move;const active=modules();const i=active.findIndex(m=>m.id===id);const target=active[i+Number(button.dataset.direction)];if(target){const ids=state.modules.map(m=>m.id);const a=ids.indexOf(id),b=ids.indexOf(target.id);[ids[a],ids[b]]=[ids[b],ids[a]];await mutate('/api/reorder',{ids});}}
  if(button.dataset.archiveModule){await changeModule({...moduleFor(button.dataset.archiveModule),archived:true});toast('模块已删除，可在回收站恢复');}
  if(button.dataset.restoreModule){await changeModule({...moduleFor(button.dataset.restoreModule),archived:false});toast('模块已恢复到白板');}
  if(button.dataset.restoreRecord){const r=state.records.find(r=>r.id===button.dataset.restoreRecord);await saveRecord({...r,deleted:false},r.updated_at);toast(moduleFor(r.module_id).archived?'记录已恢复；所属模块仍在回收站':'记录已恢复');}
  if(button.id==='undo'){await mutate('/api/undo',{});toast('已撤销上一次修改');}
 }catch(e){toast(e.message);}finally{busy=false;}
});
document.addEventListener('change',async e=>{const id=e.target.dataset.check;if(!id)return;if(busy){e.target.checked=!e.target.checked;return;}busy=true;const r=state.records.find(x=>x.id===id);e.target.disabled=true;try{await saveRecord({...r,status:e.target.checked?'done':'todo'},r.updated_at);if($('#record-dialog').open&&editingRecord)$('#related-records').innerHTML=relatedView(editingRecord);toast('计划状态已保存');}catch(error){toast(error.message);render();}finally{busy=false;}});
$('#run-import').addEventListener('click',async()=>{if(busy)return;busy=true;$('#run-import').disabled=true;try{const payload={overwrite:$('#overwrite').checked};const file=$('#import-file').files[0];if(file){if(file.size>30*1024*1024)throw Error('导入文件最多 30MB');if(file.name.toLowerCase().endsWith('.zip'))payload.archive=await base64(file);else payload.text=await file.text();}else payload.text=$('#import-text').value;const r=await mutate('/api/import',payload);$('#import-dialog').close();$('#import-text').value='';$('#import-file').value='';$('#overwrite').checked=false;changePage('board');toast(`已导入：${r.modules_added} 个新模块，${r.added} 条新记录；更新 ${r.updated}，跳过 ${r.skipped}`);}catch(e){$('#import-error').textContent=e.message;}finally{busy=false;$('#run-import').disabled=false;}});
$('#copy-prompt').addEventListener('click',async()=>{const prompt=`请将我的生活记录整理为 LifeOS JSON，只输出 {"schema_version":2,"modules":[],"records":[]}。当前模块定义如下：${JSON.stringify(state.modules)}。
使用现有模块的 id 填入每条记录的 module_id；确实需要新类别时，在 modules 中创建模块定义 {id:唯一英文编号,name:名称,kind:journal/health/shopping/plans/custom,view:list或table,fields:[],archived:false}。只返回新模块即可。常用模板：日记 journal，健康 health，购物 shopping，计划 plans，自定义 custom。
记录字段：id（稳定唯一英文编号，修订时沿用）、module_id、type（journal/activity/expense/task/note）、date（YYYY-MM-DD）、title、body、status（todo/done）、amount（字符串或null）、currency、source_id、attachments（空数组）、properties（属性编号对应文字值）。健康记录可填写模块定义中已有的 duration，购物可填写已有的 merchant；不知道就留空。
日记完整保留原文。默认只提炼明确的未来计划与已完成体育锻炼；起床、领证、普通购物、做饭、聚餐等只留在原文。用户明确提供购物小票或要求记账时才创建购物记录；若没有购物模块，同时创建它。计划与锻炼通过 source_id 关联原始日记。不要猜金额、币种、时间或时长。金额未知为null；有金额但币种未知请先询问。明天相对于原文归属日期。缺失的日期请先询问。不要将计划当成已完成。
我的记录：`;try{await navigator.clipboard.writeText(prompt);toast('已复制，粘贴到 ChatGPT 后附上你的记录');}catch(e){$('#import-error').textContent='未能复制，请允许浏览器读取剪贴板后重试。';}});
async function init(){try{state=await api('/api/state');if(!state.modules)throw Error('白板正在升级，请稍后刷新。');render();}catch(e){toast(e.message+'；请确认本地 LifeOS 已启动');}}


// Camera coordinates are independent of module world coordinates: no fixed canvas edge.
let camera={x:0,y:0,scale:1}, gesture=null, spaceHeld=false, suppressClick=false;
try { const saved=JSON.parse(localStorage.getItem('lifeos-camera')||'null');if(saved&&[saved.x,saved.y,saved.scale].every(Number.isFinite)&&saved.scale>=0.25&&saved.scale<=2)camera=saved;} catch {}
function rememberCamera(){try{localStorage.setItem('lifeos-camera',JSON.stringify(camera));}catch{}}
function applyCamera(){$('#workspace').style.transform=`translate(${camera.x}px,${camera.y}px) scale(${camera.scale})`;}
function newModuleLayout(){
 const base={x:(window.innerWidth/2-camera.x)/camera.scale-230,y:(window.innerHeight/2-camera.y)/camera.scale-120,width:460,height:300};
 let tries=0;while(tries<40&&modules().some(m=>{const p=layoutFor(m);return Math.abs(p.x-base.x)<45&&Math.abs(p.y-base.y)<45;})){base.x+=45;base.y+=45;tries++;}return base;
}
const viewport=$('#viewport');
viewport.addEventListener('pointerdown',e=>{
 if(e.button!==0&&e.button!==1)return;if(e.target.closest('button,input,select,textarea,a,summary,.menu-content'))return;
 const block=e.target.closest('.database-block');const header=e.target.closest('.module-header');const resize=e.target.closest('.resize-handle');
 if(block&&!header&&!resize&&!spaceHeld&&e.button!==1)return;if(busy||gesture)return;
 const drag=header&&!spaceHeld&&e.button===0;const resizeMode=resize&&e.button===0;const module=(drag||resizeMode)?clone(moduleFor(block.dataset.module)):null;
 gesture={pointer:e.pointerId,startX:e.clientX,startY:e.clientY,lastX:e.clientX,lastY:e.clientY,mode:resizeMode?'resize':drag?'module':'pan',module,layout:module?{...layoutFor(module)}:null,element:(drag||resizeMode)?block:null,camera:{...camera},moved:false};
 if(drag||resizeMode){block.style.zIndex=20;block.classList.add('dragging');}viewport.setPointerCapture(e.pointerId);viewport.classList.add('moving');e.preventDefault();
});
viewport.addEventListener('pointermove',e=>{
 if(!gesture||gesture.pointer!==e.pointerId)return;const g=gesture;const dx=e.clientX-g.startX,dy=e.clientY-g.startY;
 if(Math.abs(dx)+Math.abs(dy)>4)g.moved=true;g.lastX=e.clientX;g.lastY=e.clientY;
 if(g.mode==='pan'){camera.x=g.camera.x+dx;camera.y=g.camera.y+dy;applyCamera();}
 else if(g.mode==='module') {g.element.style.left=(g.layout.x+dx/camera.scale)+'px';g.element.style.top=(g.layout.y+dy/camera.scale)+'px';}
 else {g.element.style.width=Math.max(280,Math.min(1600,g.layout.width+dx/camera.scale))+'px';g.element.style.height=Math.max(160,Math.min(1200,g.layout.height+dy/camera.scale))+'px';}
});
async function finishGesture(e,cancel=false){
 if(!gesture||gesture.pointer!==e.pointerId)return;const g=gesture;gesture=null;viewport.classList.remove('moving');
 if(viewport.hasPointerCapture(e.pointerId))viewport.releasePointerCapture(e.pointerId);
 if(g.element){g.element.classList.remove('dragging');g.element.style.zIndex='';}
 if(cancel){if(g.mode==='pan'){camera=g.camera;applyCamera();}else render();return;}
 if(g.mode==='pan'){rememberCamera();return;}if(!g.moved)return;
 suppressClick=true;setTimeout(()=>suppressClick=false,0);busy=true;
 const layout={...g.layout};
 if(g.mode==='module'){layout.x=g.layout.x+(g.lastX-g.startX)/camera.scale;layout.y=g.layout.y+(g.lastY-g.startY)/camera.scale;}
 else {layout.width=Math.max(280,Math.min(1600,g.layout.width+(g.lastX-g.startX)/camera.scale));layout.height=Math.max(160,Math.min(1200,g.layout.height+(g.lastY-g.startY)/camera.scale));}
 try{await changeModule({...g.module,layout});}catch(error){toast('位置未保存：'+error.message);render();}finally{busy=false;}
}
viewport.addEventListener('pointerup',e=>finishGesture(e));viewport.addEventListener('pointercancel',e=>finishGesture(e,true));
viewport.addEventListener('click',e=>{if(suppressClick){e.preventDefault();e.stopPropagation();}},true);
viewport.addEventListener('wheel',e=>{
 if(gesture)return;const content=e.target.closest('.module-content');
 if(content&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey&&content.scrollHeight>content.clientHeight&&((e.deltaY<0&&content.scrollTop>0)||(e.deltaY>0&&content.scrollTop+content.clientHeight<content.scrollHeight-1)))return;
 e.preventDefault();const unit=e.deltaMode===1?16:e.deltaMode===2?window.innerHeight:1;
 if(e.ctrlKey||e.metaKey){const old=camera.scale;camera.scale=Math.min(2,Math.max(.25,old*Math.exp(-e.deltaY*.002)));camera.x=e.clientX-(e.clientX-camera.x)*camera.scale/old;camera.y=e.clientY-(e.clientY-camera.y)*camera.scale/old;}
 else{camera.x-=(e.shiftKey&&e.deltaX===0?e.deltaY:e.deltaX)*unit;camera.y-=(e.shiftKey&&e.deltaX===0?0:e.deltaY)*unit;}applyCamera();rememberCamera();
},{passive:false});
document.addEventListener('keydown',e=>{
 if(e.target.closest('input,textarea,select,dialog'))return;
 if(e.code==='Space'){spaceHeld=true;viewport.classList.add('space-pan');e.preventDefault();}
 if(e.key==='Escape'&&page==='board'){camera={x:0,y:0,scale:1};applyCamera();rememberCamera();}
 const header=e.target.closest('.module-header');if(header&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)&&!busy){e.preventDefault();const m=moduleFor(header.closest('[data-module]').dataset.module),p=layoutFor(m),step=e.shiftKey?50:10;busy=true;changeModule({...m,layout:{...p,x:p.x+(e.key==='ArrowLeft'?-step:e.key==='ArrowRight'?step:0),y:p.y+(e.key==='ArrowUp'?-step:e.key==='ArrowDown'?step:0)}}).catch(error=>toast(error.message)).finally(()=>busy=false);}
});
document.addEventListener('keyup',e=>{if(e.code==='Space'){spaceHeld=false;viewport.classList.remove('space-pan');}});
window.addEventListener('blur',()=>{spaceHeld=false;viewport.classList.remove('space-pan');});
init();
