import fs from 'node:fs';
import {createRequire} from 'node:module';
const require = createRequire('/app/package.json');
const {Client} = require('pg');
const {S3BlobStore}=await import('/app/dist/infrastructure/storage/s3.js');
const e=process.env, previous=(e.S3_PREVIOUS_UPLOAD_IDS||'').split(',').filter(Boolean);
const db=new Client({connectionString:e.SUPABASE_DATABASE_URL,ssl:{ca:fs.readFileSync(e.SUPABASE_DB_CA_FILE),rejectUnauthorized:true}});
await db.connect();
try {
  if(process.argv[2]==='retain'){
    await db.query('BEGIN');
    // Preserve publication state, ownership, IDs, message timestamps and access controls.
    const r=await db.query("UPDATE meldiq.attachments SET expires_at=$1 WHERE expires_at<$1",[253402300799000]);
    await db.query('COMMIT');console.log(JSON.stringify({retained:r.rowCount}));
  }else{
    await db.query('BEGIN READ ONLY');
    const r=await db.query("SELECT id,size,sha256,multipart_id FROM meldiq.attachment_uploads WHERE expires_at>$1 AND (id=ANY($2::text[]) OR left(id,9)='a_legacy_') ORDER BY id",[Date.now(),previous]);
    await db.query('COMMIT');
    if(r.rows.some(row=>row.multipart_id))throw Error('Unfinished previous-region multipart session');
    const store=new S3BlobStore({bucket:e.S3_BUCKET,region:e.S3_REGION,prefix:e.S3_PREFIX,endpoint:null,forcePathStyle:false,spoolDir:'/tmp/spool',credentials:{accessKeyId:e.S3_ACCESS_KEY_ID,secretAccessKey:e.S3_SECRET_ACCESS_KEY},sse:'AES256',kmsKeyId:null,presignedDownloads:true,presignTtlSeconds:60,multipartThreshold:67108864,partSize:16777216,previousUploads:{bucket:e.S3_PREVIOUS_UPLOAD_BUCKET,region:e.S3_PREVIOUS_UPLOAD_REGION,endpoint:null,pending:previous,olderDesktop:true}});
    let promoted=0;
    for(const row of r.rows){
      const old=await store.previousUploads.direct.head('attachments',row.id);
      if(old){await store.previousUploads.publish(row.id,Number(row.size),row.sha256);promoted++;}
    }
    console.log(JSON.stringify({ids:r.rows.map(row=>row.id),promoted}));
  }
}finally{await db.end();}
