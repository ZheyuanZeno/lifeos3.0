import type { Operation } from '../model'
export const BATCH_KIND='lifeos-operations-v1'
export const MAX_BATCH_BYTES=1024*1024
export interface OperationBatch { protocol:1; id:string; writerDeviceId:string; createdAt:string; operations:Operation[] }
export interface RemoteFile { id:string; batchId:string; digest:string; version:string }
export interface RemotePage { files:RemoteFile[]; removedIds:string[]; nextPageToken?:string; cursor?:string }
export interface RemoteAudio {id:string;file:string;sha256:string;mime:string;size:number}
export interface SyncTransport {
  readonly accountId:string
  allocateFileId():Promise<string>
  startCursor():Promise<string>
  listAll(pageToken?:string):Promise<RemotePage>
  listChanges(cursor:string,pageToken?:string):Promise<RemotePage>
  readFile(id:string):Promise<Uint8Array|null>
  createFile(id:string,bytes:Uint8Array,batchId:string,digest:string):Promise<void>
  findAudio?(file:string):Promise<RemoteAudio|null>
  createAudio?(id:string,bytes:Uint8Array,file:string,mime:string,sha256:string):Promise<void>
  syncMedia?(db:import('../database').PocketDatabase):Promise<void>
}
export interface CloudAck { key:string; accountId:string; operationId:string }
export interface CloudFile { key:string; accountId:string; fileId:string; digest:string; version:string }
export interface CloudBatch { key:string; accountId:string; fileId:string; batchId:string; digest:string; body:string; operationIds:string[]; status:'pending'|'confirmed' }
export interface CloudState { key:string; accountId:string; cursor?:string; mediaCursor?:string; acknowledgedCursor?:string; lastSuccessAt?:string; lastError?:string }
export class SyncError extends Error { constructor(message:string,public code:'auth'|'network'|'integrity'|'permission'|'remote-missing'|'cursor'|'busy'|'quota'='network'){super(message);this.name='SyncError'} }
