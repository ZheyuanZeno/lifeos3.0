import type { PocketDatabase } from '../database'
import { GoogleAuthorization,validClientId } from './google-auth'
import { GoogleDriveTransport } from './google-drive'
import { sync,pendingCount } from './engine'
import { SyncError } from './types'
declare const __GOOGLE_CLIENT_ID__:string
interface Binding { namespace:string;clientId:string;permissionId:string;label:string }
export interface DriveUIState { clientId:string;ready:boolean;preparing:boolean;connecting:boolean;syncing:boolean;connected:boolean;pending:number;label:string;lastSuccessAt?:string;error:string;bridgeError:string }
export class DriveController {
 readonly authorization=new GoogleAuthorization()
 state:DriveUIState={clientId:'',ready:false,preparing:false,connecting:false,syncing:false,connected:false,pending:0,label:'',error:'',bridgeError:''}
 private binding?:Binding
 get accountId(){return this.binding?.permissionId}
 private running?:Promise<void>
 private lastState=''
 private wake=()=>this.emit()
 constructor(private db:PocketDatabase,private changed:()=>void,private bridge?:()=>Promise<void>){
  document.addEventListener('visibilitychange',this.wake);window.addEventListener('focus',this.wake);window.addEventListener('online',this.wake);window.addEventListener('offline',this.wake);window.addEventListener('pageshow',this.wake)
 }
 private emit(){this.state.connected=this.authorization.connected;const next=JSON.stringify(this.state);if(next!==this.lastState){this.lastState=next;this.changed()}}
 dispose(){document.removeEventListener('visibilitychange',this.wake);window.removeEventListener('focus',this.wake);window.removeEventListener('online',this.wake);window.removeEventListener('offline',this.wake);window.removeEventListener('pageshow',this.wake)}
 async init(){
  const saved=(await this.db.local.get('googleDriveClientId'))?.value
  const embedded=typeof __GOOGLE_CLIENT_ID__==='undefined'?'':__GOOGLE_CLIENT_ID__
  this.state.clientId=typeof saved==='string'?saved:embedded
  if(!saved&&validClientId(embedded))await this.db.local.put({key:'googleDriveClientId',value:embedded})
  const binding=(await this.db.local.get('googleDriveBinding'))?.value as Binding|undefined
  if(binding?.clientId===this.state.clientId){this.binding=binding;this.state.label=binding.label;this.state.lastSuccessAt=(await this.db.cloudState.get(binding.namespace))?.lastSuccessAt}
  await this.refreshPending();this.emit()
  if(this.state.clientId&&navigator.onLine)void this.prepare().catch(()=>{})
 }
 async refreshPending(){this.state.pending=await pendingCount(this.db,this.binding?.namespace);this.emit()}
 async configure(clientId:string){
  clientId=clientId.trim();if(!validClientId(clientId))throw new SyncError('请输入 Google Web 客户端 ID（以 .apps.googleusercontent.com 结尾）','auth')
  if(this.state.syncing||this.state.connecting)throw new SyncError('请等待当前同步或授权结束','busy')
  if(clientId!==this.state.clientId){this.authorization.clear();this.binding=undefined;this.state.label='';this.state.lastSuccessAt=undefined}
  this.state.clientId=clientId;await this.db.local.put({key:'googleDriveClientId',value:clientId});await this.prepare()
 }
 async prepare(){
  if(this.state.preparing)return
  this.state.preparing=true;this.state.error='';this.emit()
  try{await this.authorization.prepare(this.state.clientId);this.state.ready=true}
  catch(error){this.state.ready=false;this.state.error=this.message(error);throw error}
  finally{this.state.preparing=false;this.emit()}
 }
 async connect(){
  if(this.state.connecting||this.state.syncing)return
  this.state.connecting=true;this.state.error='';this.emit()
  // authorize() is invoked synchronously from the click event, with the SDK already prepared.
  const authorization=this.authorization.authorize()
  try{
   await authorization
   const account=await GoogleDriveTransport.account(this.authorization.token,this.authorization.clear)
   const namespace=this.state.clientId+':'+account.id
   if(this.binding&&this.binding.namespace!==namespace&&!window.confirm('已选择另一个 Google 账号。继续会将本机记录同步到这个账号，是否继续？')){this.authorization.clear();return}
   this.binding={namespace,clientId:this.state.clientId,permissionId:account.id,label:account.label};this.state.label=account.label
   await this.db.local.put({key:'googleDriveBinding',value:this.binding})
   this.state.lastSuccessAt=(await this.db.cloudState.get(namespace))?.lastSuccessAt
   await this.refreshPending()
  }catch(error){this.state.error=this.message(error);this.emit()}
  finally{this.state.connecting=false;this.emit()}
 }
 disconnect(){if(this.state.syncing)return;this.authorization.clear();this.state.error='';this.emit()}
 syncNow():Promise<void>{
  if(this.running)return this.running
  if(this.state.connecting||this.state.preparing)return Promise.reject(new SyncError('请等待当前授权结束后再同步','busy'))
  this.running=this.run().finally(()=>{this.running=undefined});return this.running
 }
 private async run(){
  if(!this.binding||!this.authorization.connected){this.state.error='请点击连接 Google Drive';this.emit();return}
  if(!navigator.onLine){this.state.error='当前离线，记录已保存在本地';this.emit();return}
  this.state.syncing=true;this.state.error='';this.state.bridgeError='';this.emit()
  try{
   if(this.bridge){try{await this.bridge()}catch(error){this.state.bridgeError=this.message(error)}}
   const transport=new GoogleDriveTransport(this.binding.namespace,this.authorization.token,this.authorization.clear)
   await sync(this.db,transport)
   this.state.lastSuccessAt=(await this.db.cloudState.get(this.binding.namespace))?.lastSuccessAt
   if(this.bridge){try{await this.bridge();this.state.bridgeError=''}catch(error){this.state.bridgeError=this.message(error)}}
  }catch(error){this.state.error=this.message(error);throw error}
  finally{this.state.syncing=false;await this.refreshPending();this.emit()}
 }
 private message(error:unknown){return error instanceof Error?error.message:'同步失败，记录已保存在本地'}
 get status(){
  if(!navigator.onLine)return '离线，记录已保存在本地'
  if(this.state.syncing)return '正在同步 Google Drive…'
  if(this.state.connecting)return '正在连接 Google…'
  if(this.state.error)return this.state.error
  if(!this.state.clientId)return '尚未配置 Google Drive'
  if(!this.authorization.connected)return '需要点击连接 Google Drive'
  if(this.state.pending)return this.state.pending+' 条操作等待同步'
  return this.state.lastSuccessAt?'已同步':'已连接，等待手动同步'
 }
}
