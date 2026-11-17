export const canonical=(value:unknown):string=>JSON.stringify(order(value))
function order(value:unknown):unknown { if(Array.isArray(value))return value.map(order);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,order(v)]));return value }
export async function digest(bytes:Uint8Array){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource))].map(x=>x.toString(16).padStart(2,'0')).join('')}
