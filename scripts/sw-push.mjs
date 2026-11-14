// Kept separate so push behavior can be exercised without a real push subscription.
export const pushHandlers=String.raw`
self.addEventListener('push',event=>{event.waitUntil((async()=>{
 let payload={};try{payload=event.data?.json()||{}}catch{}
 const title=typeof payload.title==='string'?payload.title.slice(0,200):'LifeOS Pocket';
 const body=typeof payload.body==='string'?payload.body.slice(0,300):'有一条新的计划提醒';
 const id=typeof payload.id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(payload.id)?payload.id:null;
 await self.registration.showNotification(title,{body,icon:'/pocket/icon-192.png',badge:'/pocket/icon-192.png',tag:typeof payload.tag==='string'?payload.tag.slice(0,200):'lifeos-reminder',renotify:false,data:{id}});
})())});
self.addEventListener('notificationclick',event=>{event.notification.close();event.waitUntil((async()=>{
 const id=event.notification.data?.id;const valid=typeof id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(id);
 const url='/pocket/'+(valid?'?plan='+encodeURIComponent(id):'')+'#daily';
 const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
 const client=windows.find(c=>new URL(c.url).origin===self.location.origin&&new URL(c.url).pathname.startsWith('/pocket/'));
 if(client){await client.focus();client.postMessage({type:'OPEN_PLAN',id:valid?id:null})}else await self.clients.openWindow(url);
})())});
`
