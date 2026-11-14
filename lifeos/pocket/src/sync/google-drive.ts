import { BATCH_KIND,SyncError,type RemoteFile,type RemotePage,type SyncTransport,type RemoteAudio } from './types'
import { audioFile,MAX_AUDIO_BYTES } from '../media'
const API='https://www.googleapis.com/drive/v3/',UPLOAD='https://www.googleapis.com/upload/drive/v3/files'
type Fetcher=(input:string,init?:RequestInit)=>Promise<Response>
function remoteFile(value:unknown):RemoteFile|null {
 const file=value as {id?:string;version?:string;appProperties?:Record<string,string>}
 if(file?.appProperties?.lifeosKind!==BATCH_KIND)return null
 if(typeof file.id!=='string'||typeof file.version!=='string'||!/^[a-f0-9]{64}$/.test(file.appProperties.sha256??'')||!file.appProperties.batchId)throw new SyncError('Drive 文件索引格式无效','integrity')
 return {id:file.id,batchId:file.appProperties.batchId,digest:file.appProperties.sha256,version:file.version}
}
export class GoogleDriveTransport implements SyncTransport {
 constructor(readonly accountId:string,private token:()=>string,private invalidate:()=>void=()=>{},private fetcher:Fetcher=(input,init)=>fetch(input,init),private delay:(ms:number)=>Promise<void>=ms=>new Promise(r=>setTimeout(r,ms))){}
 private async request(path:string,init:RequestInit={},allow404=false,upload=false):Promise<Response>{
  for(let attempt=0;attempt<3;attempt++){
   let response:Response
   try{response=await this.fetcher(upload?path:API+path,{...init,headers:{...init.headers,Authorization:'Bearer '+this.token()},signal:AbortSignal.timeout(20000)})}
   catch(error){if(error instanceof SyncError)throw error;if(attempt===2)throw new SyncError('无法连接 Google Drive，本地记录已保留');await this.delay(300*2**attempt);continue}
   if(response.ok||(allow404&&response.status===404)||response.status===409)return response
   if(response.status===401){this.invalidate();throw new SyncError('Google 授权已过期，请点击重新连接','auth')}
   if(response.status===410)throw new SyncError('Drive 增量游标失效，请重新扫描历史','cursor')
   if(response.status===429||response.status>=500){if(attempt<2){await this.delay(300*2**attempt);continue}throw new SyncError('Google Drive 暂时繁忙，请稍后重试')}
   if(response.status===403){let reason='';try{const body=await response.json();reason=body.error?.errors?.[0]?.reason??''}catch{}if(['rateLimitExceeded','userRateLimitExceeded'].includes(reason)&&attempt<2){await this.delay(300*2**attempt);continue}throw new SyncError('Drive API 未启用、权限未授予或账户策略限制，请检查 Google Cloud 配置','permission')}
   throw new SyncError('Google Drive 请求失败（'+response.status+'），本地数据未改变')
  }
  throw new SyncError('Google Drive 连接失败')
 }
 static async account(token:()=>string,invalidate:()=>void,fetcher:Fetcher=(input,init)=>fetch(input,init)){
  const transport=new GoogleDriveTransport('',token,invalidate,fetcher),response=await transport.request('about?fields='+encodeURIComponent('user(permissionId,displayName,emailAddress)'))
  const {user}=await response.json();if(typeof user?.permissionId!=='string'||!user.permissionId)throw new SyncError('无法识别当前 Google Drive 账号','auth')
  return {id:user.permissionId as string,label:(user.emailAddress||user.displayName||'Google Drive') as string}
 }
 async allocateFileId(){const response=await this.request('files/generateIds?count=1&space=appDataFolder&type=files');const body=await response.json();if(typeof body.ids?.[0]!=='string')throw new SyncError('Drive 没有返回文件编号','integrity');return body.ids[0] as string}
 async startCursor(){const response=await this.request('changes/startPageToken?fields=startPageToken');const body=await response.json();if(typeof body.startPageToken!=='string')throw new SyncError('Drive 没有返回增量游标','integrity');return body.startPageToken as string}
 async listAll(pageToken?:string):Promise<RemotePage>{
  const query=new URLSearchParams({spaces:'appDataFolder',q:"trashed = false and appProperties has { key='lifeosKind' and value='"+BATCH_KIND+"' }",pageSize:'1000',fields:'nextPageToken,files(id,version,appProperties)'})
  if(pageToken)query.set('pageToken',pageToken)
  const response=await this.request('files?'+query),body=await response.json();if(body.files!==undefined&&!Array.isArray(body.files))throw new SyncError('Drive 文件列表无效','integrity')
  return {files:(body.files??[]).map(remoteFile).filter((v:RemoteFile|null):v is RemoteFile=>v!==null),removedIds:[],nextPageToken:body.nextPageToken}
 }
 async listChanges(cursor:string,pageToken?:string):Promise<RemotePage>{
  const query=new URLSearchParams({spaces:'appDataFolder',pageSize:'1000',includeRemoved:'true',pageToken:pageToken??cursor,fields:'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,version,appProperties))'})
  const response=await this.request('changes?'+query),body=await response.json();if(body.changes!==undefined&&!Array.isArray(body.changes))throw new SyncError('Drive 变更列表无效','integrity')
  const files:RemoteFile[]=[],removedIds:string[]=[]
  for(const change of body.changes??[]){if(change.removed&&typeof change.fileId==='string')removedIds.push(change.fileId);else if(change.file){const file=remoteFile(change.file);if(file)files.push(file)}}
  return {files,removedIds,nextPageToken:body.nextPageToken,cursor:body.newStartPageToken}
 }
 async readFile(id:string){const response=await this.request('files/'+encodeURIComponent(id)+'?alt=media',{},true);if(response.status===404)return null;return new Uint8Array(await response.arrayBuffer())}
 async findAudio(file:string):Promise<RemoteAudio|null>{
  if(!audioFile.test(file))throw new SyncError('录音文件名无效','integrity')
  const query=new URLSearchParams({spaces:'appDataFolder',q:"trashed = false and appProperties has { key='lifeosKind' and value='lifeos-audio-v1' } and appProperties has { key='mediaFile' and value='"+file+"' }",pageSize:'100',fields:'files(id,mimeType,size,appProperties)'})
  const body=await (await this.request('files?'+query)).json(),item=body.files?.[0]
  if(!item)return null
  if(typeof item.id!=='string'||!/^[a-f0-9]{64}$/.test(item.appProperties?.sha256??'')||!Number.isSafeInteger(Number(item.size))||Number(item.size)>MAX_AUDIO_BYTES)throw new SyncError('云端录音索引无效','integrity')
  return {id:item.id,file,sha256:item.appProperties.sha256,mime:item.mimeType,size:Number(item.size)}
 }
 async createAudio(id:string,bytes:Uint8Array,file:string,mime:string,sha256:string){
  const boundary='lifeos-'+crypto.randomUUID(),metadata={id,name:file,mimeType:mime,parents:['appDataFolder'],appProperties:{lifeosKind:'lifeos-audio-v1',mediaFile:file,sha256}}
  const encoder=new TextEncoder(),head=encoder.encode('--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(metadata)+'\r\n--'+boundary+'\r\nContent-Type: '+mime+'\r\n\r\n'),tail=encoder.encode('\r\n--'+boundary+'--\r\n'),body=new Uint8Array(head.length+bytes.length+tail.length)
  body.set(head);body.set(bytes,head.length);body.set(tail,head.length+bytes.length)
  const response=await this.request(UPLOAD+'?uploadType=multipart&fields=id',{method:'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},body},false,true)
  if(response.status!==409&&((await response.json()).id!==id))throw new SyncError('Drive 返回的录音编号不一致','integrity')
 }
 async createFile(id:string,bytes:Uint8Array,batchId:string,digest:string){
  const boundary='lifeos-'+crypto.randomUUID(),metadata={id,name:'lifeos-'+batchId+'.json',mimeType:'application/json',parents:['appDataFolder'],appProperties:{lifeosKind:BATCH_KIND,batchId,sha256:digest}}
  // This transport writes UTF-8 JSON operation batches; use a text multipart body on every browser.
  const body='--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(metadata)+'\r\n--'+boundary+'\r\nContent-Type: application/json\r\n\r\n'+new TextDecoder('utf-8',{fatal:true}).decode(bytes)+'\r\n--'+boundary+'--\r\n'
  const response=await this.request(UPLOAD+'?uploadType=multipart&fields=id',{method:'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},body},false,true)
  // 409 means a prior request may already have committed. The engine reads and verifies the same ID.
  if(response.status!==409){const result=await response.json();if(result.id!==id)throw new SyncError('Drive 返回的文件编号不一致','integrity')}
 }
}
