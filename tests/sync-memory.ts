import { SyncError,type SyncTransport,type RemoteFile,type RemotePage } from '../lifeos/pocket/src/sync/types'
export class MemoryDrive {
 audio=new Map<string,{id:string;file:string;sha256:string;mime:string;size:number;bytes:Uint8Array}>()
 files=new Map<string,{bytes:Uint8Array;metadata:RemoteFile}>();changes:RemoteFile[]=[];allocations=0;uploads=0;loseResponse=false;failReads=false;corrupt=false;pageSize=2;failPage=false
 transport(accountId='account'):SyncTransport {
  const drive=this
  return {
   accountId,
   async allocateFileId(){return 'remote-'+(++drive.allocations)},
   async startCursor(){return String(drive.changes.length)},
   async listAll(pageToken){const all=[...drive.files.values()].map(f=>f.metadata),start=Number(pageToken??0);if(drive.failPage&&start>0)throw new SyncError('page failed');return {files:all.slice(start,start+drive.pageSize),removedIds:[],nextPageToken:start+drive.pageSize<all.length?String(start+drive.pageSize):undefined}},
   async listChanges(cursor,pageToken){const start=Number(pageToken??cursor),slice=drive.changes.slice(start,start+drive.pageSize),next=start+drive.pageSize;return {files:slice,removedIds:[],nextPageToken:next<drive.changes.length?String(next):undefined,cursor:next>=drive.changes.length?String(drive.changes.length):undefined}},
   async readFile(id){if(drive.failReads)throw new SyncError('offline');const file=drive.files.get(id)??drive.audio.get(id);if(!file)return null;return drive.corrupt?new TextEncoder().encode('{}'):file.bytes.slice()},
   async findAudio(file){return [...drive.audio.values()].find(a=>a.file===file)??null},
   async createAudio(id,bytes,file,mime,sha256){drive.audio.set(id,{id,bytes:bytes.slice(),file,mime,sha256,size:bytes.length})},
   async createFile(id,bytes,batchId,digest){if(drive.files.has(id))throw new Error('file ID reused');drive.uploads++;const metadata={id,batchId,digest,version:'1'};drive.files.set(id,{bytes:bytes.slice(),metadata});drive.changes.push(metadata);if(drive.loseResponse){drive.loseResponse=false;throw new SyncError('success response lost')}}
  }
 }
}
