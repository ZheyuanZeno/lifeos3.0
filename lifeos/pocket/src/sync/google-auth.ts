import { SyncError } from './types'
export const DRIVE_SCOPE='https://www.googleapis.com/auth/drive.appdata'
interface TokenResponse { access_token?:string;expires_in?:number;scope?:string;error?:string;error_description?:string }
interface TokenClient { requestAccessToken(options?:{prompt?:string}):void }
interface OAuthAPI { initTokenClient(options:{client_id:string;scope:string;include_granted_scopes:boolean;callback:(value:TokenResponse)=>void;error_callback:(error:{type:string})=>void}):TokenClient;hasGrantedAllScopes(response:TokenResponse,...scopes:string[]):boolean }
declare global { interface Window { google?:{accounts:{oauth2:OAuthAPI}} } }
export const validClientId=(value:string)=>/^\d+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(value)
let loading:Promise<void>|undefined
export function loadGoogleIdentity(){
 if(window.google?.accounts.oauth2)return Promise.resolve()
 if(loading)return loading
 loading=new Promise<void>((resolve,reject)=>{
  const script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.async=true;script.dataset.lifeosGoogle='true'
  const timeout=setTimeout(()=>{script.remove();loading=undefined;reject(new SyncError('Google 授权组件加载超时，请联网后重试'))},20000)
  script.onload=()=>{clearTimeout(timeout);if(window.google?.accounts.oauth2)resolve();else{loading=undefined;reject(new SyncError('Google 授权组件不可用'))}}
  script.onerror=()=>{clearTimeout(timeout);script.remove();loading=undefined;reject(new SyncError('无法加载 Google 授权组件，本地功能仍可使用'))};document.head.append(script)
 })
 return loading
}
export class GoogleAuthorization {
 private client?:TokenClient
 private accessToken=''
 private expiresAt=0
 private pending?:{resolve:()=>void;reject:(error:Error)=>void;timeout:ReturnType<typeof setTimeout>}
 constructor(private now:()=>number=Date.now){}
 async prepare(clientId:string){
  if(!validClientId(clientId))throw new SyncError('请输入有效的 Google Web OAuth 客户端 ID','auth')
  await loadGoogleIdentity();const oauth=window.google!.accounts.oauth2
  this.client=oauth.initTokenClient({client_id:clientId,scope:DRIVE_SCOPE,include_granted_scopes:false,callback:response=>{
   if(!this.pending)return
   const pending=this.pending;clearTimeout(pending.timeout);this.pending=undefined
   if(response.error||!response.access_token||!oauth.hasGrantedAllScopes(response,DRIVE_SCOPE)){this.clear();pending.reject(new SyncError('未获得 Drive 应用数据权限，请重新授权','auth'));return}
   this.accessToken=response.access_token;this.expiresAt=this.now()+Math.max(0,Number(response.expires_in??0)*1000-30000);pending.resolve()
  },error_callback:error=>{const pending=this.pending;if(!pending)return;clearTimeout(pending.timeout);this.pending=undefined;pending.reject(new SyncError(error.type==='popup_failed_to_open'?'授权窗口未能打开，请允许弹窗并再次点击连接':error.type==='popup_closed'?'授权窗口已关闭，记录仍保存在本地':'Google 授权未完成，请重试','auth'))}})
 }
 get ready(){return !!this.client}
 get connected(){return !!this.accessToken&&this.now()<this.expiresAt}
 token=()=>{if(!this.connected){this.clear();throw new SyncError('Google 连接已过期，请点击重新连接','auth')}return this.accessToken}
 clear=()=>{this.accessToken='';this.expiresAt=0}
 authorize():Promise<void>{
  if(!this.client)return Promise.reject(new SyncError('请先保存客户端 ID 并准备授权','auth'))
  if(this.pending)return Promise.reject(new SyncError('Google 授权正在进行','busy'))
  return new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>{this.pending=undefined;reject(new SyncError('未收到授权结果，请返回应用重试','auth'))},90000)
   this.pending={resolve,reject,timeout}
   // Called directly from the click handler after prepare(), preserving iPhone's user gesture.
   try{this.client!.requestAccessToken({prompt:'select_account'})}catch{clearTimeout(timeout);this.pending=undefined;reject(new SyncError('无法打开 Google 授权窗口，请重试','auth'))}
  })
 }
}
