import {expect,it} from 'vitest'
import {runInNewContext} from 'node:vm'
import {pushHandlers} from '../scripts/sw-push.mjs'
function worker(){const handlers:Record<string,(event:any)=>void>={},shown:any[]=[],opened:any[]=[],messages:any[]=[];let existing=false;const client={url:'https://lifeos.test/pocket/#settings',focus:async()=>{},postMessage:(data:any)=>messages.push(data)};runInNewContext(pushHandlers,{URL,self:{location:{origin:'https://lifeos.test'},addEventListener:(key:string,fn:any)=>handlers[key]=fn,registration:{showNotification:async(title:string,options:any)=>shown.push({title,...options})},clients:{matchAll:async()=>existing?[client]:[],openWindow:async(url:string)=>opened.push(url)}}});return {shown,opened,messages,existing:()=>{existing=true},async fire(name:string,data:any){let promise:Promise<unknown>|undefined;handlers[name]({...data,waitUntil:(p:Promise<unknown>)=>promise=p});await promise}}}
it('push always displays a visible notification, bounds content and rejects external click URLs',async()=>{
 const sw=worker();await sw.fire('push',{data:{json:()=>({title:'a'.repeat(400),body:'b'.repeat(600),id:'https://evil.example/'})}})
 expect(sw.shown[0].title).toHaveLength(200);expect(sw.shown[0].body).toHaveLength(300);expect(sw.shown[0].data.id).toBeNull()
 await sw.fire('push',{data:{json:()=>{throw Error('bad')}}});expect(sw.shown[1].title).toBe('LifeOS Pocket')
 let closed=false;await sw.fire('notificationclick',{notification:{data:{id:'https://evil.example/'},close:()=>closed=true}});expect(sw.opened).toEqual(['/pocket/#daily']);expect(closed).toBe(true)
})
it('click focuses an existing Pocket window or opens a canonical deep link without timer mutations',async()=>{
 const sw=worker();await sw.fire('notificationclick',{notification:{data:{id:'task_123'},close(){}}});expect(sw.opened).toEqual(['/pocket/?plan=task_123#daily'])
 sw.existing();await sw.fire('notificationclick',{notification:{data:{id:'task_123'},close(){}}});expect(sw.messages).toEqual([{type:'OPEN_PLAN',id:'task_123'}]);expect(sw.opened).toHaveLength(1)
})
