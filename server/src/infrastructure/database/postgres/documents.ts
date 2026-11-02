import { DuplicateDocument, type DocumentStore, type Keyed, type Match, type FindOptions } from "../documents.js";
import { NATIVE_TABLES } from "./nativeCatalog.js";
import { identifier as q, type MeldiqPostgres } from "./client.js";
import type { TableSpec } from "../mongo/catalog.js";

const snake=(s:string)=>s.replace(/[A-Z]/g,c=>`_${c.toLowerCase()}`);
const camel=(s:string)=>s.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase());

/** Whitelisted relational implementation of the existing atomic keyed-store contract. */
export class PostgresDocuments<T extends Keyed> implements DocumentStore<T>{
  readonly backend="postgres" as const;
  private readonly spec:TableSpec;
  constructor(private readonly db:MeldiqPostgres,private readonly collection:string){
    const spec=NATIVE_TABLES.find(t=>t.name===collection);if(!spec)throw new Error("Unknown PostgreSQL document relation");this.spec=spec;
  }
  private field(key:string){const name=snake(key);if(!this.spec.columns.some(c=>c.name===name))throw new Error("Unmapped document field");return q(name);}
  private values(doc:Partial<T>){return Object.entries(doc).filter(([,v])=>v!==undefined).map(([k,v])=>{this.field(k);const col=this.spec.columns.find(c=>c.name===snake(k))!;return[k,col.type==="JSONB"?JSON.stringify(v):v] as const;});}
  private decode(row:Record<string,unknown>):T{return Object.fromEntries(Object.entries(row).map(([k,v])=>[camel(k),v])) as unknown as T;}
  private predicate(match:Match<T>,values:unknown[]){const keys=Object.entries(match);return keys.map(([k,v])=>{const col=this.field(k);if(v===null)return`${col} IS NULL`;values.push(v);return`${col}=$${values.length}`;}).join(" AND ")||"true";}
  async insert(doc:T){const fields=this.values(doc);try{await this.db.query(`INSERT INTO meldiq.${q(this.collection)} (${fields.map(([k])=>this.field(k))}) VALUES (${fields.map((_,i)=>`$${i+1}`)})`,fields.map(([,v])=>v));}catch(error){if((error as {code?:string}).code==="23505")throw new DuplicateDocument("Duplicate document");throw error;}}
  async put(doc:T){const fields=this.values(doc);await this.db.query(`INSERT INTO meldiq.${q(this.collection)} (${fields.map(([k])=>this.field(k))}) VALUES (${fields.map((_,i)=>`$${i+1}`)}) ON CONFLICT(id) DO UPDATE SET ${fields.filter(([k])=>k!=="id").map(([k])=>`${this.field(k)}=excluded.${this.field(k)}`).join(",")}`,fields.map(([,v])=>v));}
  async get(id:string):Promise<T|null>{return(await this.find({id} as Match<T>,{limit:1}))[0]??null;}
  async find(match:Match<T>,opts:FindOptions<T>={}):Promise<T[]>{
    const values:unknown[]=[];let where=this.predicate(match,values),order="";
    if(opts.newestBy){const col=this.field(opts.newestBy);if(opts.before!==undefined){values.push(opts.before);where+=` AND ${col}<$${values.length}`;}order=` ORDER BY ${col} DESC,id DESC`;}
    if(opts.limit!==undefined&&(!Number.isInteger(opts.limit)||opts.limit<0||opts.limit>10000))throw new Error("Invalid document page size");
    const limit=opts.limit===undefined?"":` LIMIT ${opts.limit}`;
    return(await this.db.query(`SELECT * FROM meldiq.${q(this.collection)} WHERE ${where}${order}${limit}`,values)).rows.map(r=>this.decode(r));
  }
  async count(match:Match<T>){const values:unknown[]=[];const where=this.predicate(match,values);return(await this.db.query(`SELECT count(*) AS n FROM meldiq.${q(this.collection)} WHERE ${where}`,values)).rows[0].n as number;}
  async update(id:string,where:Match<T>,change:Partial<T>):Promise<T|null>{
    const fields=this.values(change).filter(([k])=>k!=="id");if(!fields.length)return this.get(id);
    const values:unknown[]=fields.map(([,v])=>v),predicate=this.predicate({...where,id} as Match<T>,values);
    const result=await this.db.query(`UPDATE meldiq.${q(this.collection)} SET ${fields.map(([k],i)=>`${this.field(k)}=$${i+1}`)} WHERE ${predicate} RETURNING *`,values);
    return result.rows[0]?this.decode(result.rows[0]):null;
  }
  async take(id:string,where:Match<T>={}):Promise<T|null>{const values:unknown[]=[];const predicate=this.predicate({...where,id} as Match<T>,values);const result=await this.db.query(`DELETE FROM meldiq.${q(this.collection)} WHERE ${predicate} RETURNING *`,values);return result.rows[0]?this.decode(result.rows[0]):null;}
  async deleteMany(match:Match<T>){const values:unknown[]=[];const predicate=this.predicate(match,values);return(await this.db.query(`DELETE FROM meldiq.${q(this.collection)} WHERE ${predicate}`,values)).rowCount??0;}
  async deleteBelow(field:keyof T&string,value:number){return(await this.db.query(`DELETE FROM meldiq.${q(this.collection)} WHERE ${this.field(field)}<$1`,[value])).rowCount??0;}
}
