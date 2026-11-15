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
async function post(path,data,token){const r=await mf.dispatchFetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(data)});const text=await r.text();return {status:r.status,data:text?JSON.parse(text):{},headers:r.headers}}
async function rpc(method,params,token){return post('/mcp',{jsonrpc:'2.0',id:1,method,params},token)}
try{
 assert.equal((await rpc('tools/list',{},'')).status,401)
 const policy={from:'2026-11-15',to:'2026-12-15',time_zone:'Europe/Berlin',notes:false,modify:true}
 const enrolled=await post('/device/enroll',{device:'a'.repeat(32),policy},'google');assert.equal(enrolled.status,200,JSON.stringify(enrolled.data))
 const device=enrolled.data.token,pair=await post('/device/pair',{},device);assert.equal(pair.status,200)
 const register=await post('/oauth/register',{client_name:'Integration test',redirect_uris:['https://client.example/callback'],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'});assert.equal(register.status,201)
 const client=register.data.client_id,verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url')
 const query=new URLSearchParams({client_id:client,redirect_uri:'https://client.example/callback',response_type:'code',scope:'lifeos:read lifeos:create lifeos:modify offline_access',state:'test-state',code_challenge:challenge,code_challenge_method:'S256',resource:origin+'/mcp'})
 const consent=await mf.dispatchFetch(origin+'/authorize?'+query),html=await consent.text();assert.equal(consent.status,200);const handle=html.match(/name="handle" value="([^"]+)"/)[1],cookie=consent.headers.get('set-cookie').split(';')[0]
 const approval=await mf.dispatchFetch(origin+'/authorize',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:origin,Cookie:cookie},body:new URLSearchParams({handle,pair:device.split('.')[0]+'.'+pair.data.secret,decision:'approve',scope:'lifeos:read'}) .toString()+'&scope=lifeos:create&scope=lifeos:modify&scope=offline_access',redirect:'manual'})
 assert.equal(approval.status,302,await approval.clone().text());const code=new URL(approval.headers.get('Location')).searchParams.get('code')
 const exchange=await mf.dispatchFetch(origin+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client,redirect_uri:'https://client.example/callback',code,code_verifier:verifier,resource:origin+'/mcp'})})
 assert.equal(exchange.status,200,await exchange.clone().text());const credentials=await exchange.json();assert.ok(credentials.refresh_token);const refreshed=await mf.dispatchFetch(origin+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:client,refresh_token:credentials.refresh_token,resource:origin+'/mcp'})});assert.equal(refreshed.status,200);const token=(await refreshed.json()).access_token
 // MCP requires both supported response representations in Accept.
 async function call(method,params){const r=await mf.dispatchFetch(origin+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return {status:r.status,data:await r.json()}}
 const init=await call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}});assert.equal(init.status,200,JSON.stringify(init.data))
 const discovery=await call('tools/list',{});assert.equal(discovery.data.result.tools.length,11)
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
 const outside=await call('tools/call',{name:'lifeos_create_plan',arguments:{command_id:'outside',data:{...args.data,date:'2027-01-01'}}});assert.equal(outside.data.result.isError,true)
 const second=await post('/device/enroll',{device:'c'.repeat(32),policy},'google');await post('/device/projection',{rows:[row],sync:'manual'},second.data.token);const a=await post('/device/pending',{},device),b=await post('/device/pending',{},second.data.token);assert.equal(a.data.commands[0].command_id,b.data.commands[0].command_id);await post('/device/ack',{command_id:'update',status:'applied'},device);await post('/device/ack',{command_id:'update',status:'failed'},second.data.token);const converged=await call('tools/call',{name:'lifeos_get_command_status',arguments:{command_id:'update'}});assert.equal(JSON.parse(converged.data.result.content[0].text).command.status,'applied')
 const other=await post('/device/enroll',{device:'b'.repeat(32),policy},'other');assert.equal((await post('/device/pending',{},other.data.token)).data.commands.length,0)
 await post('/device/revoke',{},device);assert.equal((await call('tools/list',{})).status,401)
 console.log('PASS real OAuth PKCE consent/token, authenticated Streamable HTTP discovery/11 tools, queue replay, acknowledgement, isolation, unsupported advance reminders and revocation')
}finally{await mf.dispose()}
