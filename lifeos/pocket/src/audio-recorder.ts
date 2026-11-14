import { MAX_AUDIO_BYTES } from './media'
export interface Recording {blob:Blob;durationMs:number}
export class AudioCapture {
 private recorder?:MediaRecorder
 private stream?:MediaStream
 private timer?:ReturnType<typeof setTimeout>
 private parts:Blob[]=[]
 private size=0
 private stopping?:Promise<Recording>
 private completed?:Recording
 private resolveStop?:(value:Recording)=>void
 private rejectStop?:(error:Error)=>void
 startedAt=0
 starting=false
 constructor(private changed:()=>void,private autoStop:()=>void){}
 get active(){return this.recorder?.state==='recording'}
 async start(){
  if(this.active||this.starting)return
  if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined')throw Error('此浏览器不支持录音，请使用 Safari 或 Chrome 并允许麦克风')
  this.starting=true;this.changed()
  try{
   this.stream=await navigator.mediaDevices.getUserMedia({audio:true})
   const mimeType=['audio/mp4','audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus'].find(m=>MediaRecorder.isTypeSupported(m))
   this.recorder=new MediaRecorder(this.stream,{...(mimeType?{mimeType}:{}),audioBitsPerSecond:64000})
   this.parts=[];this.size=0;this.stopping=undefined;this.completed=undefined;this.resolveStop=undefined;this.rejectStop=undefined
   this.recorder.addEventListener('dataavailable',event=>{if(event.data.size){this.parts.push(event.data);this.size+=event.data.size}if(this.size>=MAX_AUDIO_BYTES-65536&&this.active)this.autoStop()})
   this.recorder.addEventListener('stop',()=>{
    clearTimeout(this.timer);const blob=new Blob(this.parts,{type:this.recorder?.mimeType??this.parts[0]?.type??'audio/mp4'}),durationMs=Math.max(0,Date.now()-this.startedAt)
    this.completed={blob,durationMs};this.release();if(this.resolveStop)this.resolveStop(this.completed);else this.autoStop();this.changed()
   },{once:true})
   this.recorder.addEventListener('error',()=>{this.release();this.rejectStop?.(Error('录音中断，请保留已录内容后重试'));this.changed()},{once:true})
   this.startedAt=Date.now();this.recorder.start(1000)
   this.timer=setTimeout(()=>{if(this.active)this.autoStop()},5*60*1000)
  }catch(error){this.release();throw new Error(error instanceof DOMException&&error.name==='NotAllowedError'?'麦克风权限未开启，请在浏览器设置中允许后重试':error instanceof DOMException&&error.name==='NotFoundError'?'没有检测到麦克风':error instanceof Error?error.message:'无法开始录音')}
  finally{this.starting=false;this.changed()}
 }
 stop():Promise<Recording>{
  if(this.completed)return Promise.resolve(this.completed)
  if(this.stopping)return this.stopping
  if(!this.active)return Promise.reject(Error('当前没有正在录制的语音'))
  this.stopping=new Promise((resolve,reject)=>{this.resolveStop=resolve;this.rejectStop=reject;this.recorder!.stop()})
  return this.stopping
 }
 private release(){clearTimeout(this.timer);this.stream?.getTracks().forEach(track=>track.stop());this.stream=undefined}
}
