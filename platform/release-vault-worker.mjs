import {parentPort,workerData} from "node:worker_threads";
import {createReleaseVault} from "./release-vault.mjs";
try{
  const {root,action,input}=workerData;
  if(!["readRelease","publishNativeRelease"].includes(action))throw new Error("Unsupported vault operation");
  parentPort.postMessage({result:createReleaseVault({root})[action](input)});
}catch(error){parentPort.postMessage({error:{code:String(error.code||"VAULT_OPERATION_FAILED"),message:String(error.message).slice(0,2000)}});}
