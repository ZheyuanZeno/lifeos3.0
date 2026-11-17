const actions=new Set(['create','status','pair/request','pair/approve','pair/claim','recover','recovery/rotate','device/revoke','batch/put','batch/get','changes','media/status','media/begin','media/put','media/commit','media/get','cursor/ack','manifest','archive/register','archive/rebind','archive/ack','migration/prepare','migration/verify','activate'])
export const onRequest:PagesFunction=async({request,params})=>{
 const action=String(params.path??'').replace(/,/g,'/')
 if(request.method!=='POST'||!actions.has(action))return new Response('Not found',{status:404})
 const origin=request.headers.get('Origin');if(origin&&origin!==new URL(request.url).origin)return new Response('Forbidden',{status:403})
 const chunks:Uint8Array[]=[];let size=0;const reader=request.body?.getReader()
 if(reader)while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>2*1024*1024){await reader.cancel();return new Response('Too large',{status:413})}chunks.push(part.value)}
 const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length}
 const headers=new Headers({'Content-Type':'application/json'});for(const key of ['Space','Device','Time','Nonce','Signature'])headers.set('X-LifeOS-'+key,request.headers.get('X-LifeOS-'+key)??'')
 try{const result=await fetch('https://lifeos-sync.lifeos-pocket.workers.dev/v1/'+action,{method:'POST',headers,body:bytes,redirect:'manual',signal:AbortSignal.timeout(25000)});return new Response(result.body,{status:result.status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}})}catch{return Response.json({error:'自动同步服务暂时不可达，本机数据已保留',code:'network'},{status:502})}
}
