// A short-lived, read-only snapshot of the two largest tables. No row is published until the active
// writer lease has compared the *complete* visible tuple membership in a newer repeatable snapshot.
import pg, {type PoolClient} from "pg";
import {MemoryRows} from "./memory.js";
import type {TableSpec} from "../mongo/catalog.js";
import type {MeldiqPostgres} from "../postgres/client.js";
import type {Row} from "./types.js";
const names=["resource_samples","delivery_queue"] as const;
type Name=(typeof names)[number];
type Page={keys:string[]; masks:bigint[]};
export class PreparedPages extends MemoryRows{
  readonly backend="postgres" as const;
  private readonly pages=new Map<string,Map<number,Page>>();
  private timer?:NodeJS.Timeout;
  private live=true;
  private snapshot="";
  private readonly broken=()=>{this.live=false;};
  private constructor(specs:TableSpec[],private readonly reader:PoolClient){super(specs);reader.once("error",this.broken);}
  protected async persist():Promise<void>{throw new Error("A prepared snapshot cannot write");}
  static async capture(db:MeldiqPostgres,specs:TableSpec[]):Promise<PreparedPages>{
    const selected=specs.filter(t=>names.includes(t.name as Name));
    if(selected.length!==names.length)throw Error("Missing release snapshot tables");
    const reader=await db.connect(),p=new PreparedPages(selected,reader);
    try{
      await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL idle_in_transaction_session_timeout='60s'; SET LOCAL statement_timeout='20s'; SET LOCAL lock_timeout='400ms'");
      p.snapshot=(await reader.query("SELECT pg_current_snapshot()::text AS snapshot")).rows[0].snapshot;
      // Pin both ordinary heaps and their access-share locks in this transaction. Reject partitions,
      // inheritance or a non-heap table access method rather than treating their TIDs as one relation.
      await reader.query('LOCK TABLE ONLY meldiq.resource_samples, ONLY meldiq.delivery_queue IN ACCESS SHARE MODE');
      const check=await reader.query("SELECT c.relname FROM pg_class c JOIN pg_am a ON a.oid=c.relam WHERE c.relnamespace='meldiq'::regnamespace AND c.relname=ANY($1::text[]) AND c.relkind='r' AND NOT c.relhassubclass AND NOT c.relispartition AND a.amname='heap'",[names]);
      if(check.rowCount!==2)throw Error("Prepared release requires ordinary heaps");
      for(const t of names){
        const pages=new Map<number,Page>();p.pages.set(t,pages);
        await stream(reader,`SELECT x.*,ctid::text AS _release_tid FROM ONLY meldiq."${t}" x`,row=>{
          const tid=String(row._release_tid).match(/^\((\d+),(\d+)\)$/);
          if(!tid)throw Error("Malformed snapshot TID");
          // Keep loaded objects in compact property layouts. Deleting the extra TID in place
          // puts hundreds of thousands of ordinary rows into dictionary storage in V8.
          const {_release_tid,...data}=row;
          const block=Number(tid[1]),slot=Number(tid[2]),half=slot>>6;
          let page=pages.get(block);if(!page){page={keys:[],masks:[]};pages.set(block,page);}
          if(page.keys[slot]!==undefined)throw Error("Duplicate snapshot slot");
          page.keys[slot]=p.load(t,data);page.masks[half]=(page.masks[half]??0n)|(1n<<BigInt(slot%64));
        });
      }
      p.timer=setTimeout(()=>p.discard(),45_000);p.timer.unref();return p;
    }catch(e){p.discard();throw e;}
  }
  discard(){if(this.timer)clearTimeout(this.timer);this.live=false;if(!this.released){this.released=true;this.reader.release(true);}}
  private released=false;
  async reconcile(lease:PoolClient){
    if(!this.live)throw Error("Prepared snapshot expired");
    // Detect session loss/timeout before or during comparison. A held repeatable snapshot
    // prevents vacuum from recycling an old visible tuple. The keys below are not logical IDs.
    const assertReader=async()=>{
      if(!this.live||(await this.reader.query("SELECT pg_current_snapshot()::text AS snapshot")).rows[0].snapshot!==this.snapshot)
        throw Error("Prepared snapshot no longer pinned");
    };
    await assertReader();
    const block="((ctid::text::point)[0])::int",slot="((ctid::text::point)[1])::int";
    const current=await lease.query(names.map(t=>
      `SELECT '${t}' AS t,${block} AS page,(${slot}/64) AS half,bit_or(1::bigint << (${slot}%64))::text AS mask FROM ONLY meldiq."${t}" GROUP BY 2,3`).join(" UNION ALL "));
    // The latest snapshot was pinned while the original was still live. On disconnect we fail closed.
    await assertReader();
    const dirty=new Map<Name,Set<number>>(),seen=new Set<string>();
    for(const t of names)dirty.set(t,new Set());
    for(const r of current.rows){
      const t=r.t as Name,page=Number(r.page),half=Number(r.half);
      if(!dirty.has(t)||!Number.isSafeInteger(page)||page<0||!Number.isSafeInteger(half)||half<0)throw Error("Invalid heap mask");
      seen.add(t+":"+page+":"+half);
      if(this.pages.get(t)!.get(page)?.masks[half]!==BigInt.asUintN(64,BigInt(r.mask)))dirty.get(t)!.add(page);
    }
    for(const t of names){
      const pages=this.pages.get(t)!;
      for(const [p,old] of pages)old.masks.forEach((mask,h)=>{if(mask&&!seen.has(t+":"+p+":"+h))dirty.get(t)!.add(p);});
      const changed=[...dirty.get(t)!].sort((a,b)=>a-b);
      const state=this.state(t);
      if(changed.length>256)throw Error("Snapshot churn exceeds release limit");
      for(const p of changed)for(const k of pages.get(p)?.keys??[])if(k!==undefined)state.rows.delete(k);
      if(changed.length){
        const predicate=changed.map(p=>`(ctid>='(${p},0)'::tid AND ctid<'(${p+1},0)'::tid)`).join(" OR ");
        await stream(lease,`SELECT * FROM ONLY meldiq."${t}" WHERE ${predicate}`,r=>{this.load(t,r);});
      }
      // The fenced snapshot and row_counters decide the next ID, even if its old maximum was deleted.
      state.nextId=1;
      if(state.spec.autoincrement)for(const r of state.rows.values())state.nextId=Math.max(state.nextId,Number(r[state.spec.primaryKey[0]])+1);
    }
    this.pages.clear();return names.map(t=>[t,this.state(t)] as const);
  }
}
async function stream(c:PoolClient,text:string,each:(row:Row)=>void){
  const query=new pg.Query<Row>({text});let failure:unknown;
  query.on("row",row=>{if(!failure)try{each(row);}catch(e){failure=e;}});
  await new Promise<void>((resolve,reject)=>{query.once("error",reject);query.once("end",()=>failure?reject(failure):resolve());c.query(query);});
}
