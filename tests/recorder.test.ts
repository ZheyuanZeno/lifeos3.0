import {afterEach,expect,it,vi} from 'vitest'
import {AudioCapture,type Recording} from '../lifeos/pocket/src/audio-recorder'
afterEach(()=>vi.unstubAllGlobals())
it('retains audio when the browser stops capture without a user click and releases the microphone',async()=>{
 const release=vi.fn();let native:FixtureRecorder
 class FixtureRecorder extends EventTarget {
  state='inactive';mimeType='audio/mp4';static isTypeSupported(){return true}
  constructor(){super();native=this}
  start(){this.state='recording'}
  stop(){this.state='inactive';const event=new Event('dataavailable');Object.defineProperty(event,'data',{value:new Blob(['encoded'],{type:'audio/mp4'})});this.dispatchEvent(event);this.dispatchEvent(new Event('stop'))}
 }
 vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop:release}]})}});vi.stubGlobal('MediaRecorder',FixtureRecorder)
 let saved:Promise<Recording>|undefined
 const capture=new AudioCapture(()=>{},()=>{saved=capture.stop()});await capture.start();native!.stop()
 expect((await saved)?.blob.size).toBe(7);expect(release).toHaveBeenCalledOnce();expect(capture.active).toBe(false)
 await capture.start();expect(capture.active).toBe(true);await capture.stop();expect(release).toHaveBeenCalledTimes(2)
})
