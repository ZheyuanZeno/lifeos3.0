import type { BrowserContext,Page } from '@playwright/test'
export async function syntheticMicrophone(target:BrowserContext|Page){
 await target.addInitScript(()=>{
  Object.defineProperty(window,'__nativeRecorder',{value:typeof MediaRecorder!=='undefined'})
  // The Windows Playwright WebKit build omits MediaRecorder. Use a WAV fixture there;
  // Chromium exercises the native encoder. iPhone's native encoder still requires device QA.
  if(typeof MediaRecorder==='undefined'){
   class FixtureRecorder extends EventTarget {
    state='inactive';mimeType='audio/wav'
    static isTypeSupported(){return false}
    start(){this.state='recording'}
    stop(){
     this.state='inactive'
     const count=16000,buffer=new ArrayBuffer(44+count*2),view=new DataView(buffer)
     const text=(at:number,s:string)=>{for(let i=0;i<s.length;i++)view.setUint8(at+i,s.charCodeAt(i))}
     text(0,'RIFF');view.setUint32(4,36+count*2,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,count*2,true)
     for(let i=0;i<count;i++)view.setInt16(44+i*2,Math.sin(i*2*Math.PI*440/16000)*3000,true)
     queueMicrotask(()=>{const event=new Event('dataavailable');Object.defineProperty(event,'data',{value:new Blob([buffer],{type:'audio/wav'})});this.dispatchEvent(event);this.dispatchEvent(new Event('stop'))})
    }
   }
   Object.defineProperty(window,'MediaRecorder',{value:FixtureRecorder})
  }
  if(!navigator.mediaDevices)Object.defineProperty(navigator,'mediaDevices',{value:{}})
  Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{
   if(typeof AudioContext==='undefined')return {getTracks:()=>[{stop(){}}]}
   const audio=new AudioContext(),oscillator=audio.createOscillator(),destination=audio.createMediaStreamDestination()
   oscillator.frequency.value=440;oscillator.connect(destination);oscillator.start();await audio.resume()
   for(const track of destination.stream.getTracks()){
    const stop=track.stop.bind(track)
    track.stop=()=>{stop();oscillator.stop();void audio.close()}
   }
   return destination.stream
  }})
 })
}
