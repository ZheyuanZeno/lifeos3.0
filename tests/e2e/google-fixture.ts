import type { BrowserContext } from '@playwright/test'
import { createHash } from 'node:crypto'
export const MEMORY_TOKEN='test-memory-access-token-DO-NOT-PERSIST'
export class GoogleAPI {
 requests:Array<{method:string;path:string}>=[]
 files=new Map<string,{id:string;version:string;appProperties:Record<string,string>;body:Buffer;mimeType:string;size:string}>()
 changes:string[]=[]
 nextId=0
 unauthorized=false
 pauseUploads=false
 private uploads:Array<()=>void>=[]
 release(){this.pauseUploads=false;for(const resolve of this.uploads.splice(0))resolve()}
 async attach(context:BrowserContext){
  await context.route('https://accounts.google.com/gsi/client',route=>route.fulfill({contentType:'text/javascript',body:`window.google={accounts:{oauth2:{initTokenClient(options){window.__requestedScopes=options.scope;return {requestAccessToken(){window.__authWasDirect=!!navigator.userActivation?.isActive;queueMicrotask(()=>options.callback({access_token:${JSON.stringify(MEMORY_TOKEN)},expires_in:3600,scope:options.scope}))}}},hasGrantedAllScopes(response,scope){return response.scope===scope}}}};`}))
  await context.route('https://www.googleapis.com/**',async route=>{
   const request=route.request(),url=new URL(request.url()),path=url.pathname
   const headers={'Access-Control-Allow-Origin':request.headers().origin??'*','Access-Control-Allow-Headers':'authorization,content-type','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Content-Type':'application/json'}
   const reply=(body:unknown,status=200)=>route.fulfill({status,headers,body:typeof body==='string'?body:JSON.stringify(body)})
   if(request.method()==='OPTIONS')return route.fulfill({status:204,headers})
   this.requests.push({method:request.method(),path})
   if(this.unauthorized)return reply({error:{code:401}},401)
   if(request.headers().authorization!=='Bearer '+MEMORY_TOKEN)return reply({error:'missing bearer'},401)
   if(path.endsWith('/about'))return reply({user:{permissionId:'mock-account',emailAddress:'sync-test@example.invalid'}})
   if(path.endsWith('/files/generateIds'))return reply({ids:['file-'+(++this.nextId)]})
   if(path.endsWith('/changes/startPageToken'))return reply({startPageToken:String(this.changes.length)})
   if(path==='/drive/v3/files'){const q=url.searchParams.get('q')??'',audio=q.includes("lifeos-audio-v1");return reply({files:[...this.files.values()].filter(f=>audio?f.appProperties.lifeosKind==='lifeos-audio-v1'&&q.includes(f.appProperties.mediaFile):f.appProperties.lifeosKind==='lifeos-operations-v1').map(({body,...metadata})=>metadata)})}
   if(path==='/drive/v3/changes')return reply({newStartPageToken:String(this.changes.length),changes:this.changes.slice(Number(url.searchParams.get('pageToken'))).map(id=>({fileId:id,file:this.files.get(id)}))})
   if(path.startsWith('/drive/v3/files/')){const file=this.files.get(path.split('/').at(-1)!);return file?route.fulfill({status:200,headers:{...headers,'Content-Type':file.mimeType},body:file.body}):reply({},404)}
   if(path==='/upload/drive/v3/files'){
    if(this.pauseUploads)await new Promise<void>(resolve=>this.uploads.push(resolve))
    const boundary=request.headers()['content-type'].split('boundary=')[1],raw=request.postDataBuffer()
    if(!raw)throw Error('Mock transport received no upload bytes')
    const separator=Buffer.from('\r\n\r\n'),divider=Buffer.from('\r\n--'+boundary)
    const metadataStart=raw.indexOf(separator)+4,metadataEnd=raw.indexOf(divider,metadataStart),metadata=JSON.parse(raw.subarray(metadataStart,metadataEnd).toString('utf8'))
    const bodyStart=raw.indexOf(separator,metadataEnd+divider.length)+4,bodyEnd=raw.lastIndexOf(divider),body=raw.subarray(bodyStart,bodyEnd)
    if(createHash('sha256').update(body).digest('hex')!==metadata.appProperties.sha256)return reply({error:'digest mismatch'},400)
    if(this.files.has(metadata.id))return reply({},409)
    this.files.set(metadata.id,{id:metadata.id,version:'1',appProperties:metadata.appProperties,body,mimeType:metadata.mimeType,size:String(body.length)});this.changes.push(metadata.id);return reply({id:metadata.id})
   }
   return reply({error:'unhandled mock URL'},404)
  })
 }
}
