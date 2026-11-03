// Production preflight only. One connection with the writer's existing restricted login; no writer lease.
const pg=require('pg'),fs=require('fs');
(async()=>{
 const p=new pg.Client({connectionString:process.env.SUPABASE_DATABASE_URL,ssl:{rejectUnauthorized:true,ca:fs.readFileSync(process.env.SUPABASE_DB_CA_FILE)},connectionTimeoutMillis:3000,statement_timeout:1800,application_name:'meldiq-phase3-readiness'});
 const at=new Date().toISOString();try{
 await p.connect();await p.query('BEGIN READ ONLY');
 const r=await p.query("select current_setting('transaction_read_only') as mode, rolconnlimit as role_limit, not(rolsuper or rolcreaterole or rolcreatedb or rolbypassrls or rolreplication) as restricted, pg_has_role(current_user,'meldiq_api','USAGE') as api from pg_roles where rolname=current_user");
 await p.query('ROLLBACK');console.log(JSON.stringify({at,admitted:true,...r.rows[0]}));
 }catch(e){console.log(JSON.stringify({at,admitted:false,sqlstate:/^[A-Z0-9]{5}$/.test(e.code??'')?e.code:null}));}finally{await p.end().catch(()=>{});}
})();
