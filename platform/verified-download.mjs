/** Bounded, asynchronous verification into an unlinked private snapshot.
 * No artifact bytes are served until the complete expected hash is verified.
 * The same open snapshot inode supplies the response, avoiding a second read
 * from a potentially replaced source. Slots stay occupied until delivery ends.
 */
import {createHash,randomBytes} from "node:crypto";
import {constants as FS,createReadStream} from "node:fs";
import {mkdir,open,unlink} from "node:fs/promises";
import {join} from "node:path";

const failure=(code,message)=>Object.assign(new Error(message),{code,status:503});
const aborted=()=>Object.assign(new Error("Download cancelled"),{name:"AbortError",code:"ABORT_ERR"});
const checkAbort=signal=>{if(signal?.aborted)throw aborted();};

/** @param {{directory:string,concurrency?:number,maxQueued?:number,maxBytes?:number,waitMs?:number}} options */
export function createVerifiedDownloads({directory,concurrency=2,maxQueued=4,maxBytes=512*1024*1024,waitMs=30000}){
  if(!directory||![concurrency,maxQueued,maxBytes,waitMs].every(Number.isSafeInteger)
    ||concurrency<1||maxQueued<0||maxBytes<1||waitMs<1)throw new Error("Invalid verified download limits");
  let active=0;const queue=[];
  const acquire=signal=>new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(aborted());return;}
    let timer,waiting=true;
    const remove=()=>{clearTimeout(timer);signal?.removeEventListener("abort",cancel);const i=queue.indexOf(start);if(i>=0)queue.splice(i,1);};
    const cancel=()=>{if(!waiting)return;waiting=false;remove();reject(aborted());};
    const start=()=>{
      waiting=false;remove();active++;let released=false;
      resolve(()=>{if(released)return;released=true;active--;queue[0]?.();});
    };
    if(active<concurrency){start();return;}
    if(queue.length>=maxQueued){reject(failure("DOWNLOAD_BUSY","All download slots are occupied. Retry shortly."));return;}
    queue.push(start);signal?.addEventListener("abort",cancel,{once:true});
    timer=setTimeout(()=>{if(!waiting)return;waiting=false;remove();reject(failure("DOWNLOAD_BUSY","Download queue wait expired. Retry shortly."));},waitMs);
  });

  async function prepare(path,receipt,{signal=undefined}={}){
    if(!Number.isSafeInteger(receipt?.bytes)||receipt.bytes<0||!/^[a-f0-9]{64}$/.test(receipt?.sha256||""))
      throw failure("ARTIFACT_RECEIPT","The artifact receipt is invalid");
    if(receipt.bytes>maxBytes)throw failure("DOWNLOAD_LIMIT","This artifact exceeds the configured download size limit");
    const release=await acquire(signal);let input,snapshot,tempPath,disposed=false;
    const dispose=async()=>{
      if(disposed)return;disposed=true;
      try{if(snapshot)await snapshot.close();}
      finally{if(tempPath)await unlink(tempPath).catch(()=>{});release();}
    };
    try{
      checkAbort(signal);
      input=await open(path,FS.O_RDONLY|(FS.O_NOFOLLOW||0)|(FS.O_NONBLOCK||0));
      const stat=await input.stat();
      if(!stat.isFile()||stat.size!==receipt.bytes)throw failure("ARTIFACT_INTEGRITY","Artifact length or file type does not match its receipt");
      await mkdir(directory,{recursive:true,mode:0o700});
      tempPath=join(directory,`download-${process.pid}-${randomBytes(16).toString("hex")}.tmp`);
      snapshot=await open(tempPath,"wx+",0o600);
      // Supported runtime hosts are Linux/macOS. Unlinking the open file keeps
      // it private and ensures crashes cannot leave cached snapshot bytes.
      await unlink(tempPath);tempPath=null;
      const hash=createHash("sha256"),buffer=Buffer.allocUnsafe(256*1024);let total=0;
      while(true){
        checkAbort(signal);
        const {bytesRead}=await input.read(buffer,0,buffer.length,null);if(!bytesRead)break;
        total+=bytesRead;
        if(total>receipt.bytes)throw failure("ARTIFACT_INTEGRITY","Artifact grew beyond its receipt");
        hash.update(buffer.subarray(0,bytesRead));
        let offset=0;
        while(offset<bytesRead){checkAbort(signal);offset+=(await snapshot.write(buffer,offset,bytesRead-offset)).bytesWritten;}
      }
      if(total!==receipt.bytes||hash.digest("hex")!==receipt.sha256)
        throw failure("ARTIFACT_INTEGRITY","Artifact bytes do not match their frozen receipt");
      checkAbort(signal);await input.close();input=null;
      let streamed=false;
      return {bytes:receipt.bytes,sha256:receipt.sha256,dispose,
        stream(){
          if(streamed||disposed)throw new Error("Verified download has already been consumed");
          streamed=true;return createReadStream(null,{fd:snapshot.fd,start:0,autoClose:false,highWaterMark:64*1024});
        }};
    }catch(error){if(input)await input.close().catch(()=>{});await dispose();throw error;}
  }
  return Object.freeze({prepare,state:()=>({active,queued:queue.length,concurrency,maxQueued,maxBytes})});
}
