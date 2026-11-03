import fs from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";

export const CUTOVER_MESSAGE="Meldiq is briefly unavailable. Please try again shortly.";
type Task=()=>void|Promise<void>;

/** Durable authority commit point. Before activation, background effects and customer requests stay held. */
export class DatabaseCutover {
  private tasks:Task[]=[];
  private activation?:Promise<void>;
  private active=false;
  private durable=false;
  readonly file:string;
  constructor(readonly dataDir:string,readonly projectRef:string,readonly sourceSha256:string,readonly allowActivation=true){
    if(!/^[a-z]{20}$/.test(projectRef)||!/^[a-f0-9]{64}$/.test(sourceSha256))throw new Error("Database cutover identity is invalid");
    this.file=path.join(dataDir,"database-authority.json");
    if(fs.existsSync(this.file)){
      const stat=fs.lstatSync(this.file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077)throw new Error("Database authority receipt must be a private regular file");
      const receipt=JSON.parse(fs.readFileSync(this.file,"utf8"));
      if(receipt.version!==1||receipt.projectRef!==projectRef||receipt.sourceSha256!==sourceSha256||typeof receipt.activatedAt!=="string"||!Number.isFinite(Date.parse(receipt.activatedAt)))throw new Error("Persisted database authority does not match the accepted source");
      this.active=this.allowActivation;this.durable=true;
    }
  }
  get held(){return !this.active;}
  status(){return {projectRef:this.projectRef,sourceSha256:this.sourceSha256,held:this.held,activationDurable:this.durable};}
  async whenActive(task:Task):Promise<void>{if(this.active)await task();else this.tasks.push(task);}
  async activate(source:string):Promise<void>{
    if(!this.allowActivation)throw new Error("This read-only rehearsal cannot activate a database authority");
    if(source!==this.sourceSha256)throw new Error("Activation must name the exact reconciled source fingerprint");
    if(this.active)return;
    return this.activation??=this.commit();
  }
  private async commit(){
    const temporary=this.file+"."+randomUUID()+".tmp";
    let fd:number|undefined;
    try{
      fd=fs.openSync(temporary,"wx",0o600);
      fs.writeFileSync(fd,JSON.stringify({version:1,projectRef:this.projectRef,sourceSha256:this.sourceSha256,activatedAt:new Date().toISOString()})+"\n");
      fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
      // Linking creates the authority receipt without replacing a concurrent or older receipt.
      fs.linkSync(temporary,this.file);this.durable=true;fs.unlinkSync(temporary);
      const directory=fs.openSync(this.dataDir,"r");try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
      for(const task of this.tasks)await task();
      this.tasks=[];this.active=true;
    }catch(error){
      if(this.durable)throw new Error("PostgreSQL authority is committed; repair background startup and keep PostgreSQL authoritative",{cause:error});
      throw error;
    }finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  }
}

export async function afterDatabaseActivation(cutover:DatabaseCutover|undefined,task:Task):Promise<void>{
  if(cutover)await cutover.whenActive(task);else await task();
}
