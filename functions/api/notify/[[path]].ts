interface Env {NOTIFY_BACKEND?:string}
export const onRequest:PagesFunction<Env>=async({request,env})=>{
 const path=new URL(request.url).pathname.slice('/api/notify/'.length)
 const methods:Record<string,string[]>={config:['GET'],enroll:['POST'],state:['PUT'],subscription:['PUT','DELETE'],test:['POST'],device:['DELETE'],status:['GET']}
 const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}})
 if(!methods[path]?.includes(request.method))return json({error:'Not found'},404)
 if(!env.NOTIFY_BACKEND)return path==='config'?json({ready:false}):json({error:'通知后台尚未配置'},503)
 const origin=request.headers.get('Origin')
 if(origin&&origin!==new URL(request.url).origin)return json({error:'来源无效'},403)
 if(Number(request.headers.get('Content-Length'))>2*1024*1024)return json({error:'请求超过 2MB'},413)
 try{
  const raw=request.method==='GET'?undefined:await request.arrayBuffer()
  if(raw&&raw.byteLength>2*1024*1024)return json({error:'请求超过 2MB'},413)
  const response=await fetch(new URL('/'+path,env.NOTIFY_BACKEND),{method:request.method,headers:{Authorization:request.headers.get('Authorization')??'','Content-Type':'application/json'},body:raw,redirect:'manual',signal:AbortSignal.timeout(20000)})
  if(response.status>=300&&response.status<400){await response.body?.cancel();return json({error:'通知后台地址无效'},502)}
  return new Response(response.body,{status:response.status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}})
 }catch{return json({error:'通知服务连接失败，请稍后重试'},502)}
}
