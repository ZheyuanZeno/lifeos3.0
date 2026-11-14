export interface Binding {account:string;inbox?:string;context?:string}
export class DocsAdapter {
 constructor(private token:()=>string,private fetcher:typeof fetch=(input,init)=>fetch(input,init)){}
 private async request(url:string,method='GET',body?:unknown){
  const r=await this.fetcher(url,{method,headers:{Authorization:'Bearer '+this.token(),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000),redirect:'error'})
  if(!r.ok)throw Error(r.status===401?'AI Docs 授权过期，请重新连接':r.status===404?'AI 文档已删除或当前账号无权访问':r.status===403?'未获文档权限，或未启用 Google Docs API':'Google 文档请求失败 '+r.status)
  const reader=r.body?.getReader();let text='',bytes=0;const decoder=new TextDecoder()
  if(reader)while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>1500000){await reader.cancel();throw Error('文档过大，请轮换 Inbox')}text+=decoder.decode(part.value,{stream:true})}
  return JSON.parse(text+decoder.decode())
 }
 async account():Promise<string>{const a=await this.request('https://www.googleapis.com/drive/v3/about?fields=user(permissionId)');if(!a.user?.permissionId)throw Error('无法确认 Google 账号');return a.user.permissionId}
 async create(kind:'Inbox'|'Context'):Promise<string>{const r=await this.request('https://www.googleapis.com/drive/v3/files?fields=id','POST',{name:'LifeOS AI '+kind,mimeType:'application/vnd.google-apps.document'});if(typeof r.id!=='string'||!/^[\w-]{1,200}$/.test(r.id))throw Error('文档创建失败');return r.id}
 async read(id:string):Promise<{text:string;revision:string;end:number}>{
  if(!/^[\w-]{1,200}$/.test(id))throw Error('文档 ID 无效')
  const doc=await this.request('https://docs.googleapis.com/v1/documents/'+id+'?includeTabsContent=true')
  if(doc.tabs?.length>1||doc.tabs?.[0]?.childTabs?.length)throw Error('请使用专用的单标签 AI 文档')
  const content=doc.body?.content??doc.tabs?.[0]?.documentTab?.body?.content??[]
  let text='';for(const p of content){if(p.table||p.sectionBreak&&p.endIndex>1)throw Error('AI 文档只支持普通文本');for(const e of p.paragraph?.elements??[])if(e.textRun)text+=e.textRun.content}
  return {text,revision:doc.revisionId,end:content.at(-1)?.endIndex??2}
 }
 async replace(id:string,text:string){
  if(text.length>262144)throw Error('上下文超过 256K 字符，请缩小范围')
  const old=await this.read(id);if(!old.revision)throw Error('无法获取文档版本，未写入')
  const requests:unknown[]=[];if(old.end>2)requests.push({deleteContentRange:{range:{startIndex:1,endIndex:old.end-1}}})
  requests.push({insertText:{endOfSegmentLocation:{},text}})
  await this.request('https://docs.googleapis.com/v1/documents/'+id+':batchUpdate','POST',{writeControl:{requiredRevisionId:old.revision},requests})
  const check=await this.read(id);if(check.text.trimEnd()!==text.trimEnd())throw Error('上下文回读不一致，请重试；未宣称更新成功')
 }
}
