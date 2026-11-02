import type { TableSpec, ColumnSpec } from "../mongo/catalog.js";
import { tableSpecs } from "../mongo/catalog.js";

/** Explicit fields from the release's native Mongo stores, not arbitrary whole-document JSONB.
 * Arrays are bounded configuration/metric sets; commands/activity/options are flexible rendering documents.
 */
const column=(name:string,type:string,notNull=true):ColumnSpec=>({name,type,notNull});
const fields=(text:string,integer="",nullableText="",nullableInteger="",boolean="",json="",arrays=""):ColumnSpec[]=>[
  ...text.split(" ").filter(Boolean).map(n=>column(n,"TEXT")),...integer.split(" ").filter(Boolean).map(n=>column(n,"INTEGER")),
  ...nullableText.split(" ").filter(Boolean).map(n=>column(n,"TEXT",false)),...nullableInteger.split(" ").filter(Boolean).map(n=>column(n,"INTEGER",false)),
  ...boolean.split(" ").filter(Boolean).map(n=>column(n,"BOOLEAN")),...json.split(" ").filter(Boolean).map(n=>column(n,"JSONB")),...arrays.split(" ").filter(Boolean).map(n=>column(n,"TEXT[]")),
];
const table=(name:string,domain:TableSpec["domain"],columns:ColumnSpec[],refs:Record<string,string>={}):TableSpec=>({name,domain,columns:[column("id","TEXT"),...columns],primaryKey:["id"],indexes:[],foreignKeys:Object.entries(refs).map(([name,parent])=>({columns:[name],table:parent,references:["id"],onDelete:"CASCADE"})),autoincrement:false});
export const NATIVE_TABLES:TableSpec[]=[
  table("points_accounts","identity",fields("","balance earned_total level streak updated_at","last_visit_day")),
  table("points_ledger","identity",fields("user_id kind day","amount at","detail"),{user_id:"users"}),
  table("points_days","identity",[...fields("user_id day","earned","","","","","chats reacted replied"),column("minutes","BIGINT[]")],{user_id:"users"}),
  table("points_invites","identity",fields("inviter_id joiner_id org_id state","joined_at","","settled_at"),{inviter_id:"users",joiner_id:"users",org_id:"orgs"}),
  table("oauth_apps","identity",fields("owner_id name secret_hash","created_at updated_at secret_rotated_at","","","","","redirect_uris"),{owner_id:"users"}),
  table("oauth_codes","identity",fields("app_id user_id redirect_uri","created_at expires_at","challenge family_id","used_at","","","scopes"),{app_id:"oauth_apps",user_id:"users"}),
  table("oauth_grants","identity",fields("app_id user_id","created_at updated_at","","","","","scopes"),{app_id:"oauth_apps",user_id:"users"}),
  table("oauth_tokens","identity",fields("app_id user_id access_hash refresh_hash","access_expires_at refresh_expires_at created_at rotated_at","previous_refresh_hash","","confidential","","scopes"),{app_id:"oauth_apps",user_id:"users"}),
  table("bots","identity",fields("owner_id token_hash","created_at token_rotated_at","","","public","commands"),{owner_id:"users"}),
  table("bot_interactions","identity",fields("bot_id user_id org_id conversation_id command state","created_at expires_at","","delivered_at replied_at","","options"),{bot_id:"bots",user_id:"users",org_id:"orgs",conversation_id:"conversations"}),
  table("profile_decorations","identity",fields("creator_id name status format","size created_at wearers","reviewed_by reason","reviewed_at","animated"),{creator_id:"users"}),
  // Favorites also refer to built-in catalog IDs and intentionally survive a decoration being taken down.
  table("decoration_favorites","identity",fields("user_id decoration_id","created_at"),{user_id:"users"}),
  table("privacy_settings","identity",fields("group_add_policy","updated_at","","","suggestable")),
  table("community_pins","workspace",fields("org_id name format created_by","created_at","description","","animated"),{org_id:"orgs"}),
  table("community_pin_awards","workspace",fields("pin_id org_id user_id awarded_by","awarded_at"),{pin_id:"community_pins",org_id:"orgs",user_id:"users"}),
  table("community_rules","workspace",fields("updated_by","updated_at","channel_id","","required","rules")),
  table("community_rule_agreements","workspace",fields("org_id user_id","agreed_at"),{org_id:"orgs",user_id:"users"}),
  table("user_activities","identity",fields("","updated_at expires_at","","","","activity")),
  table("username_holds","identity",fields("user_id","created_at expires_at"),{user_id:"users"}),
  table("creator_verifications","identity",fields("user_id platform channel_name link status proof_type","proof_size created_at","notes reason reviewed_by username_at_approval","reviewed_at"),{user_id:"users"}),
  table("creator_program","identity",fields("user_id status","created_at","reason reviewed_by","reviewed_at"),{user_id:"users"}),
  table("creator_posts","identity",fields("user_id url platform","created_at","reward_note reviewed_by","views reviewed_at","counted"),{user_id:"users"}),
  table("linked_accounts","identity",fields("user_id provider external_id name url items_kind","connected_at updated_at checked_at","tokens","","visible","items"),{user_id:"users"}),
  table("linked_account_starts","identity",fields("user_id provider verifier","expires_at"),{user_id:"users"}),
];
for(const [name,parent] of Object.entries({points_accounts:"users",bots:"users",user_activities:"users",privacy_settings:"users",community_rules:"orgs"})) NATIVE_TABLES.find(t=>t.name===name)!.foreignKeys.push({columns:["id"],table:parent,references:["id"],onDelete:"CASCADE"});
export const postgresTableSpecs=()=>[...tableSpecs(),...NATIVE_TABLES];

export function normalizeNativeDocument(name:string,doc:Record<string,unknown>):Record<string,unknown>{
  const spec=NATIVE_TABLES.find(t=>t.name===name);
  if(!spec)throw new Error("Unknown native collection");
  const row:Record<string,unknown>={...doc,id:doc._id};delete row._id;
  if(name==="points_days")for(const [key,value]of Object.entries({earned:0,minutes:[],chats:[],reacted:[],replied:[]}))if(row[key]===undefined)row[key]=value;
  return row;
}
