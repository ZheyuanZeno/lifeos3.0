import {Miniflare} from 'miniflare'
import {build} from 'esbuild'
import {createHash,randomBytes} from 'node:crypto'
import assert from 'node:assert/strict'
const origin='https://lifeos-mcp.lifeos-pocket.workers.dev'
const bundle=await build({entryPoints:['workers/mcp/src/index.ts'],bundle:true,write:false,format:'esm',platform:'node',target:'es2023',external:['node:*','cloudflare:*']})
const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-01',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],kvNamespaces:['OAUTH_KV'],durableObjects:{HUB:{className:'LifeOSHub',useSQLite:true}},bindings:{MCP_ORIGIN:origin},outboundService:async req=>{
 if(new URL(req.url).hostname==='www.googleapis.com')return Response.json({user:{permissionId:req.headers.get('Authorization')==='Bearer other'?'other':'owner'}})
 throw Error('Unexpected upstream')
}})
let testIP='192.0.2.1'
async function post(path,data,token){const r=await mf.dispatchFetch(origin+path,{method:'POST',headers:{'CF-Connecting-IP':testIP,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(data)});const text=await r.text();return {status:r.status,data:text?JSON.parse(text):{},headers:r.headers}}
async function rpc(method,params,token){return post('/mcp',{jsonrpc:'2.0',id:1,method,params},token)}
try{
 assert.equal((await rpc('tools/list',{},'')).status,401)
 const policy={from:'2026-11-15',to:'2026-12-15',time_zone:'Europe/Berlin',notes:true,modify:true,daily:true}
 const enrolled=await post('/device/enroll',{device:'a'.repeat(32),policy},'google');assert.equal(enrolled.status,200,JSON.stringify(enrolled.data))
 const device=enrolled.data.token
 const register=await post('/oauth/register',{client_name:'Integration test',redirect_uris:['https://client.example/callback'],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'});assert.equal(register.status,201)
 const client=register.data.client_id
 async function authorize(scopes,requested=scopes,deviceToken=device){
  const pair=await post('/device/pair',{},deviceToken);assert.equal(pair.status,200)
  const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url')
  const query=new URLSearchParams({client_id:client,redirect_uri:'https://client.example/callback',response_type:'code',scope:requested.join(' '),state:'test-state',code_challenge:challenge,code_challenge_method:'S256',resource:origin+'/mcp'})
  const consent=await mf.dispatchFetch(origin+'/authorize?'+query),html=await consent.text();assert.equal(consent.status,200);assert.ok(html.includes('读取和管理随手记（含正文）'));const handle=html.match(/name="handle" value="([^"]+)"/)[1],cookie=consent.headers.get('set-cookie').split(';')[0]
  const form=new URLSearchParams({handle,pair:deviceToken.split('.')[0]+'.'+pair.data.secret,decision:'approve'});for(const scope of scopes)form.append('scope',scope)
  const approval=await mf.dispatchFetch(origin+'/authorize',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:origin,Cookie:cookie},body:form,redirect:'manual'})
  assert.equal(approval.status,302,await approval.clone().text());const code=new URL(approval.headers.get('Location')).searchParams.get('code')
  const exchange=await mf.dispatchFetch(origin+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client,redirect_uri:'https://client.example/callback',code,code_verifier:verifier,resource:origin+'/mcp'})})
  assert.equal(exchange.status,200,await exchange.clone().text());return exchange.json()
 }
 const credentials=await authorize(['lifeos:read','lifeos:create','lifeos:modify','offline_access']);assert.ok(credentials.refresh_token);const refreshed=await mf.dispatchFetch(origin+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:client,refresh_token:credentials.refresh_token,resource:origin+'/mcp'})});assert.equal(refreshed.status,200);let token=(await refreshed.json()).access_token
 // MCP requires both supported response representations in Accept.
 async function call(method,params,accessToken=token){const r=await mf.dispatchFetch(origin+'/mcp',{method:'POST',headers:{'CF-Connecting-IP':testIP,Authorization:'Bearer '+accessToken,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return {status:r.status,data:await r.json()}}
 const init=await call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}});assert.equal(init.status,200,JSON.stringify(init.data))
 const discovery=await call('tools/list',{});assert.equal(discovery.data.result.tools.length,30)
 const noFull=await call('tools/call',{name:'lifeos_list_content',arguments:{entity:'records'}});assert.equal(JSON.parse(noFull.data.result.content[0].text).required_scope,'lifeos:full')
 const args={command_id:'test-create',data:{title:'截图识别后的会议（模拟）',date:'2026-11-18',source_id:'image:mock:1'}}
 const created=await call('tools/call',{name:'lifeos_create_plan',arguments:args});assert.equal(created.status,200);const queued=JSON.parse(created.data.result.content[0].text);assert.equal(queued.status,'queued')
 await call('tools/call',{name:'lifeos_create_plan',arguments:args});const pending=await post('/device/pending',{},device);assert.equal(pending.data.commands.length,1)
 await post('/device/ack',{command_id:'test-create',status:'applied'},device);const status=await call('tools/call',{name:'lifeos_get_command_status',arguments:{command_id:'test-create'}});assert.equal(JSON.parse(status.data.result.content[0].text).command.status,'applied')
 const advance=await call('tools/call',{name:'lifeos_create_plan',arguments:{...args,command_id:'advance',data:{...args.data,reminder_minutes_before:30}}});assert.equal(advance.data.result.isError,true)
 const row={id:'plan-1',type:'task',title:'Existing',date:'2026-11-18',status:'todo',source_id:'image:existing',updated_version:'a'.repeat(64),deadline:'',planned_start:'',time_zone:'Europe/Berlin'}
 assert.equal((await post('/device/projection',{rows:[row],sync:'manual'},device)).status,200)
 const queryPlans=await call('tools/call',{name:'lifeos_list_plans',arguments:{from:policy.from,to:policy.to}});assert.equal(JSON.parse(queryPlans.data.result.content[0].text).items[0].id,'plan-1')
 const conflict=await call('tools/call',{name:'lifeos_update_plan',arguments:{command_id:'stale',id:row.id,expected_version:'b'.repeat(64),data:{title:'Changed'}}});assert.equal(JSON.parse(conflict.data.result.content[0].text).status,'conflict')
 const update=await call('tools/call',{name:'lifeos_update_plan',arguments:{command_id:'update',id:row.id,expected_version:row.updated_version,data:{title:'Changed'}}});assert.equal(JSON.parse(update.data.result.content[0].text).status,'review')
 const notes=await call('tools/call',{name:'lifeos_list_notes',arguments:{from:policy.from,to:policy.to}});assert.equal(notes.data.result.isError,true)
 assert.equal(JSON.parse(notes.data.result.content[0].text).required_scope,'lifeos:notes')
 const permissions=JSON.parse((await call('tools/call',{name:'lifeos_get_status',arguments:{}})).data.result.content[0].text).permissions;assert.equal(permissions.notes,false);assert.equal(permissions.device_allows_notes,true);assert.equal(permissions.reconnect_required,true)
 const noDaily=await call('tools/call',{name:'lifeos_list_daily_records',arguments:{date:'2026-11-18'}});assert.equal(JSON.parse(noDaily.data.result.content[0].text).required_scope,'lifeos:daily')
 const daily={id:'session1',subject_id:'routine1',subject_kind:'routine',title:'Study',date:'2026-11-18',started_at:'2026-11-18T10:00:00Z',ended_at:'2026-11-18T11:00:00Z',time_zone:'Europe/Berlin',duration_ms:3600000,day_duration_ms:3600000,note:'Session note',updated_version:'c'.repeat(64)}
 const note={...row,id:'note-1',type:'note',title:'Quick note',body:'Authorized note body'};assert.equal((await post('/device/projection',{rows:[row,note],daily_rows:[daily],sync:'manual'},device)).status,200)
 const withNotes=await authorize(['lifeos:read','lifeos:create','lifeos:modify','lifeos:notes','lifeos:daily','offline_access'],['lifeos:read','lifeos:create','offline_access']);const readable=await call('tools/call',{name:'lifeos_list_notes',arguments:{from:policy.from,to:policy.to}},withNotes.access_token);assert.equal(readable.data.result.isError,false);assert.equal(JSON.parse(readable.data.result.content[0].text).items[0].body,note.body)
 const dayResult=await call('tools/call',{name:'lifeos_list_daily_records',arguments:{date:'2026-11-18'}},withNotes.access_token);const day=JSON.parse(dayResult.data.result.content[0].text);assert.equal(day.items[0].note,'Session note');assert.equal(day.total_effective_ms,3600000);assert.equal(day.complete,true)
 const wrongDay=await call('tools/call',{name:'lifeos_list_daily_records',arguments:{date:'2027-01-01'}},withNotes.access_token);assert.equal(wrongDay.data.result.isError,true)
 const oldGrant=await call('tools/call',{name:'lifeos_list_notes',arguments:{from:policy.from,to:policy.to}});assert.equal(oldGrant.status,401);token=withNotes.access_token
 const hidden=await call('tools/call',{name:'lifeos_get_plan',arguments:{id:note.id}});assert.equal(JSON.parse(hidden.data.result.content[0].text).plan,null)
 const outside=await call('tools/call',{name:'lifeos_create_plan',arguments:{command_id:'outside',data:{...args.data,date:'2027-01-01'}}});assert.equal(outside.data.result.isError,true)
 const second=await post('/device/enroll',{device:'c'.repeat(32),policy},'google');await post('/device/projection',{rows:[row],sync:'manual'},second.data.token);const a=await post('/device/pending',{},device),b=await post('/device/pending',{},second.data.token);assert.equal(a.data.commands[0].command_id,b.data.commands[0].command_id);await post('/device/ack',{command_id:'update',status:'applied'},device);await post('/device/ack',{command_id:'update',status:'failed'},second.data.token);const converged=await call('tools/call',{name:'lifeos_get_command_status',arguments:{command_id:'update'}});assert.equal(JSON.parse(converged.data.result.content[0].text).command.status,'applied')
 await post('/device/projection',{rows:[row],daily_rows:[daily],sync:'manual'},second.data.token)
 const duplicateDay=JSON.parse((await call('tools/call',{name:'lifeos_list_daily_records',arguments:{date:'2026-11-18'}})).data.result.content[0].text);assert.equal(duplicateDay.total_count,1);assert.equal(duplicateDay.total_effective_ms,3600000)
 await post('/device/projection',{rows:[row],daily_rows:[{...daily,note:'concurrent edit',updated_version:'d'.repeat(64)}],sync:'manual'},second.data.token)
 const conflictDay=JSON.parse((await call('tools/call',{name:'lifeos_list_daily_records',arguments:{date:'2026-11-18'}})).data.result.content[0].text);assert.equal(conflictDay.items[0].conflict,true);assert.equal(conflictDay.complete,false);assert.equal(conflictDay.total_effective_ms,0)
 const limited=await post('/device/enroll',{device:'d'.repeat(32),policy:{...policy,daily:false}},'google');assert.equal((await post('/device/projection',{rows:[],daily_rows:[daily]},limited.data.token)).status,400)
 const other=await post('/device/enroll',{device:'b'.repeat(32),policy},'other');assert.equal((await post('/device/pending',{},other.data.token)).data.commands.length,0)
 await post('/device/revoke',{},device);assert.equal((await call('tools/list',{})).status,401)
 testIP='192.0.2.2'
 const fullEnrolled=await post('/device/enroll',{device:'a'.repeat(32),policy:{...policy,full:true}},'google');assert.equal(fullEnrolled.status,200);const fullDevice=fullEnrolled.data.token
 const fullGrant=await authorize(['lifeos:read','lifeos:full','offline_access'],['lifeos:read'],fullDevice);token=fullGrant.access_token
 const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x),hash=v=>createHash('sha256').update(canonical(v)).digest('hex')
 const audio=Buffer.alloc(2044);audio.write('RIFF');audio.writeUInt32LE(2036,4);audio.write('WAVEfmt ',8);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);audio.writeUInt32LE(8000,24);audio.writeUInt32LE(16000,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(2000,40)
 const file='a'.repeat(32)+'.wav',audioSHA=createHash('sha256').update(audio).digest('hex')
 const module={id:'full-module',name:'All content',kind:'custom',view:'list',fields:[],archived:false,layout:null}
 const record={id:'full-note',module_id:module.id,type:'note',title:'Old note',date:'2020-01-01',body:'Full private business fixture',time_label:'',amount:null,currency:'',status:'done',source_id:'idea:fixture',attachments:[{file,name:'Recording.wav'}],properties:{},created_at:'2020-01-01T10:00:00Z',updated_at:'2020-01-01T10:00:00Z',deleted:false}
 const routine={id:'full-routine',title:'Study',icon:'',category:'Study',days:[0,1,2,3,4,5,6],minimumMinutes:null,targetMinutes:30,order:0,archived:false,created_at:'2020-01-01T10:00:00Z',updated_at:'2020-01-01T10:00:00Z'}
 const rows=[{entity:'modules',data:module},{entity:'records',data:record},{entity:'routines',data:routine}].map(r=>({...r,id:r.data.id,version:hash(r.data)})),generation=hash(rows)
 assert.equal((await post('/device/business',{phase:'begin',generation,count:rows.length},fullDevice)).status,200)
 assert.equal((await post('/device/business',{phase:'page',generation,rows},fullDevice)).status,200)
 assert.equal((await post('/device/business',{phase:'commit',generation},fullDevice)).status,200)
 const fullStatus=JSON.parse((await call('tools/call',{name:'lifeos_get_status',arguments:{}})).data.result.content[0].text);assert.equal(fullStatus.permissions.full,true);assert.equal(fullStatus.allowed_range.mode,'all_business_dates')
 const oldNotes=JSON.parse((await call('tools/call',{name:'lifeos_list_notes',arguments:{from:'2020-01-01',to:'2020-01-01'}})).data.result.content[0].text);assert.equal(oldNotes.items[0].body,record.body)
 const all=JSON.parse((await call('tools/call',{name:'lifeos_list_content',arguments:{entity:'records'}})).data.result.content[0].text);assert.equal(all.items[0].data.body,record.body)
 const idea=JSON.parse((await call('tools/call',{name:'lifeos_create_idea',arguments:{command_id:'full-idea',data:{title:'New idea',date:'2000-01-01',body:'New'}}})).data.result.content[0].text);assert.equal(idea.status,'queued');assert.equal(idea.command.protocol,'lifeos-native-v2')
 const pendingFull=await post('/device/pending',{},fullDevice);assert.equal(pendingFull.data.commands[0].command.tool,'lifeos_create_idea')
 await post('/device/ack',{command_id:'full-idea',status:'applied',targets:['created-idea']},fullDevice);const targetStatus=JSON.parse((await call('tools/call',{name:'lifeos_get_command_status',arguments:{command_id:'full-idea'}})).data.result.content[0].text);assert.deepEqual(targetStatus.command.targets,['created-idea'])
 const edit=JSON.parse((await call('tools/call',{name:'lifeos_update_record',arguments:{command_id:'full-edit',id:record.id,expected_version:hash(record),data:{body:'Changed'}}})).data.result.content[0].text);assert.equal(edit.status,'review')
 const staleEdit=JSON.parse((await call('tools/call',{name:'lifeos_update_record',arguments:{command_id:'full-stale',id:record.id,expected_version:'0'.repeat(64),data:{body:'Stale'}}})).data.result.content[0].text);assert.equal(staleEdit.status,'conflict')
 const waitAudio=JSON.parse((await call('tools/call',{name:'lifeos_read_attachment',arguments:{file}})).data.result.content[0].text);assert.equal(waitAudio.status,'not_ready')
 assert.equal((await post('/device/media',{phase:'status',file,sha256:audioSHA,size:audio.length},fullDevice)).status,200)
 assert.equal((await post('/device/media',{phase:'chunk',file,index:0,data:audio.toString('base64')},fullDevice)).status,200)
 assert.equal((await post('/device/media',{phase:'commit',file},fullDevice)).status,200)
 const audioRead=JSON.parse((await call('tools/call',{name:'lifeos_read_attachment',arguments:{file}})).data.result.content[0].text);assert.deepEqual(Buffer.from(audioRead.data,'base64'),audio);assert.equal(audioRead.sha256,audioSHA);assert.equal(audioRead.attachment_notes[0].body,record.body)
 const resource=await call('tools/call',{name:'lifeos_read_attachment',arguments:{file,format:'resource'}});assert.equal(resource.data.result.content[1].resource.mimeType,'audio/wav');assert.deepEqual(Buffer.from(resource.data.result.content[1].resource.blob,'base64'),audio)
 const audioBlock=await call('tools/call',{name:'lifeos_read_attachment',arguments:{file,format:'audio'}});assert.equal(audioBlock.data.result.content[1].type,'audio')
 const orphan=await call('tools/call',{name:'lifeos_read_attachment',arguments:{file:'b'.repeat(32)+'.wav'}});assert.equal(orphan.data.result.isError,true)
 const gen2='e'.repeat(64);await post('/device/business',{phase:'begin',generation:gen2,count:2},fullDevice);await post('/device/business',{phase:'page',generation:gen2,rows:[rows[0]]},fullDevice);assert.equal((await post('/device/business',{phase:'commit',generation:gen2},fullDevice)).status,400)
 const unchanged=JSON.parse((await call('tools/call',{name:'lifeos_get_content',arguments:{entity:'records',id:record.id}})).data.result.content[0].text);assert.equal(unchanged.item.data.body,record.body);assert.equal(unchanged.complete,false)
 await post('/device/revoke',{},fullDevice);assert.equal((await call('tools/list',{})).status,401)
 console.log('PASS real OAuth PKCE consent/token, authenticated Streamable HTTP discovery/30 tools, queue replay, acknowledgement, isolation, unsupported advance reminders and revocation')
}finally{await mf.dispose()}
