import {Worker} from "node:worker_threads";

/** Whole-release verification and sealing can hash/copy many large files.
 * Run them outside HTTP handling, with bounded admission. A publication keeps
 * running after a client disconnects so its original sealed intent survives.
 * A killed worker may leave staging evidence; existing audits fail closed.
 */
export function createReleaseVaultTasks({root,concurrency=2,timeoutMs=180000}){
  let active=0;
  return async(action,input)=>{
    if(active>=concurrency)throw Object.assign(new Error("Release verification is busy. Retry shortly."),{code:"VAULT_BUSY",status:503});
    active++;
    try{return await new Promise((resolve,reject)=>{
      const worker=new Worker(new URL("./release-vault-worker.mjs",import.meta.url),{
        workerData:{root,action,input},env:{},resourceLimits:{maxOldGenerationSizeMb:128}});
      let settled=false,outcome,workerError;
      const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(result);};
      const timer=setTimeout(()=>{
        // Keep the concurrency slot until the worker has actually stopped.
        workerError=Object.assign(new Error("Release verification timed out; preserved evidence requires a retry or operator check."),{code:"VAULT_TIMEOUT",status:503});
        void worker.terminate();
      },timeoutMs);
      worker.once("message",message=>{outcome=message;});
      worker.once("error",error=>{workerError=error;});
      worker.once("exit",code=>{
        if(workerError)return finish(workerError);
        if(outcome?.error)return finish(Object.assign(new Error(outcome.error.message),{code:outcome.error.code,status:503}));
        if(code===0&&outcome)return finish(null,outcome.result);
        finish(Object.assign(new Error(`Release worker exited before reporting a result (${code})`),{code:"VAULT_WORKER_EXIT",status:503}));
      });
    });}finally{active--;}
  };
}
