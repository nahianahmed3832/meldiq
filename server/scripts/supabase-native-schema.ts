import fs from "node:fs";
import path from "node:path";
import { NATIVE_TABLES } from "../src/infrastructure/database/postgres/nativeCatalog.js";
const root=process.argv[2];if(!root)throw new Error("Web root required");
const q=(s:string)=>`"${s}"`;
const types:Record<string,string>={TEXT:"text",INTEGER:"bigint",BOOLEAN:"boolean",JSONB:"jsonb","TEXT[]":"text[]","BIGINT[]":"bigint[]"};
const lines=["-- Explicit normalized fields from native Mongo implementations in release695f80b1."];
for(const t of NATIVE_TABLES){
  lines.push(`CREATE TABLE meldiq.${q(t.name)} (\n${t.columns.map(c=>`  ${q(c.name)} ${types[c.type]}${c.notNull?" NOT NULL":""}`).join(",\n")},\n  PRIMARY KEY(id)\n);`);
  for(const c of t.columns.filter(c=>c.name!=="id"&&(/_id$/.test(c.name)||/(?:_at|_expires_at)$/.test(c.name))))lines.push(`CREATE INDEX ${q(`native_${t.name}_${c.name}`)} ON meldiq.${q(t.name)} (${q(c.name)});`);
  lines.push(`ALTER TABLE meldiq.${q(t.name)} ENABLE ROW LEVEL SECURITY;`,`ALTER TABLE meldiq.${q(t.name)} FORCE ROW LEVEL SECURITY;`,`REVOKE ALL ON meldiq.${q(t.name)} FROM PUBLIC, anon, authenticated;`,`GRANT SELECT, INSERT, UPDATE, DELETE ON meldiq.${q(t.name)} TO meldiq_api;`,`CREATE POLICY trusted_backend ON meldiq.${q(t.name)} FOR ALL TO meldiq_api USING(true) WITH CHECK(true);`);
}
for(const t of NATIVE_TABLES)for(const[i,f]of t.foreignKeys.entries())lines.push(`ALTER TABLE meldiq.${q(t.name)} ADD CONSTRAINT ${q(`native_${t.name}_fk_${i}`)} FOREIGN KEY (${f.columns.map(q)}) REFERENCES meldiq.${q(f.table)} (${f.references.map(q)}) ON DELETE ${f.onDelete} DEFERRABLE INITIALLY DEFERRED;`);
for(const[table,fields]of Object.entries({points_days:["user_id","day"],points_invites:["org_id","joiner_id"],community_pin_awards:["pin_id","user_id"],community_rule_agreements:["org_id","user_id"],decoration_favorites:["user_id","decoration_id"],linked_accounts:["user_id","provider"],oauth_grants:["app_id","user_id"]}))lines.push(`CREATE UNIQUE INDEX ${q(`native_${table}_ownership`)} ON meldiq.${q(table)} (${fields.map(q)});`);
for(const[table,fields]of Object.entries({bots:["token_hash"],oauth_tokens:["access_hash","refresh_hash","previous_refresh_hash"]}))for(const f of fields)lines.push(`CREATE UNIQUE INDEX ${q(`native_${table}_${f}_unique`)} ON meldiq.${q(table)} (${q(f)});`);
for(const table of ["creator_verifications","creator_program"])lines.push(`CREATE UNIQUE INDEX ${q(`native_${table}_pending_user`)} ON meldiq.${q(table)}(user_id) WHERE status='pending';`);
lines.push("CREATE UNIQUE INDEX native_creator_post_url ON meldiq.creator_posts(user_id,url);","ALTER TABLE meldiq.points_accounts ADD CHECK(balance >= 0 AND earned_total >= 0 AND level >= 1 AND streak >= 0);","ALTER TABLE meldiq.points_invites ADD CHECK(state IN ('pending','credited','lapsed','capped'));","ALTER TABLE meldiq.profile_decorations ADD CHECK(status IN ('pending','approved','rejected','removed') AND size >= 0 AND wearers >= 0);");
for(const table of ["creator_verifications","creator_program"])lines.push(`ALTER TABLE meldiq.${q(table)} ADD CHECK(status IN ('pending','approved','rejected'));`);
fs.writeFileSync(path.join(root,"supabase/migrations/20261102000400_native_relations.sql"),lines.join("\n")+"\n");
fs.writeFileSync(path.join(root,"supabase/generated/native-catalog.json"),JSON.stringify({tables:NATIVE_TABLES},null,2)+"\n");
console.log(JSON.stringify({nativeTables:NATIVE_TABLES.length}));
