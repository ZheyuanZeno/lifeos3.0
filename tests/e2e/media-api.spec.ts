import {test,expect} from './fixtures'
import {createHash} from 'node:crypto'
test('desktop audio endpoint authenticates writes, rejects collisions and never follows file paths',async({request})=>{
 const state=await(await request.get('/api/state')).json(),name='a'.repeat(32)+'.wav',bytes=Buffer.from([0,255,128,20,1]),headers={'X-LifeOS-Token':state.token,'Content-Type':'audio/wav'}
 expect((await request.post('/api/pocket/media/'+name,{data:bytes})).status()).toBe(403)
 expect((await request.post('/api/pocket/media/'+name,{headers:{...headers,Origin:'https://example.invalid'},data:bytes})).status()).toBe(403)
 for(let i=0;i<2;i++){const response=await request.post('/api/pocket/media/'+name,{headers,data:bytes});expect(response.ok()).toBe(true);expect((await response.json()).sha256).toBe(createHash('sha256').update(bytes).digest('hex'))}
 expect((await request.post('/api/pocket/media/'+name,{headers,data:Buffer.from('different')})).status()).toBe(400)
 await expect((await request.get('/attachments/'+name)).body()).resolves.toEqual(bytes)
 expect((await request.post('/api/pocket/media/..%2Fescape.wav',{headers,data:bytes})).status()).toBe(400)
 expect((await request.post('/api/pocket/media/'+'b'.repeat(32)+'.wav',{headers,data:Buffer.alloc(4*1024*1024+1)})).status()).toBe(400)
})
