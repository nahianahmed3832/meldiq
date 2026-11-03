// Run in the active API container with an explicit ID allowlist. Keep stdout private.
const fs = require('node:fs');
const {createHash} = require('node:crypto');
const path = require('node:path');
const {MongoClient} = require('mongodb');
const {S3Client,HeadObjectCommand,PutObjectCommand} = require('@aws-sdk/client-s3');
async function main(){
  const bucket=process.env.FRA_BUCKET;
  if(!bucket || bucket===process.env.S3_BUCKET || process.env.S3_REGION!=='ap-southeast-1' || process.env.STORAGE_READ_FALLBACK!=='local') throw Error('Wrong source/destination');
  const client=new MongoClient(process.env.MONGODB_URI,{appName:'meldiq-readonly-disk-fallback',maxPoolSize:1});
  const s3=new S3Client({region:'eu-central-1',credentials:{accessKeyId:process.env.S3_ACCESS_KEY_ID,secretAccessKey:process.env.S3_SECRET_ACCESS_KEY},maxAttempts:3});
  try {
    const collection=client.db(process.env.MONGODB_DB).collection('attachments');
    for(const id of JSON.parse(process.env.STAGE_IDS)){
      if(!/^[A-Za-z0-9_-]{1,64}$/.test(id))throw Error('Invalid ID');
      const item=await collection.findOne({_id:id,expires_at:{$gt:Date.now()}},{projection:{_id:1,size:1,sha256:1}});
      if(!item)throw Error('Attachment no longer current');
      const file=path.join(process.env.ATTACHMENT_DIR || path.join(process.env.DATA_DIR,'attachments'),id);
      const size=fs.statSync(file).size;
      const digest=createHash('sha256');
      for await(const chunk of fs.createReadStream(file))digest.update(chunk);
      const checksum=digest.digest('base64');
      if(size!==item.size || (item.sha256 && item.sha256!==checksum && item.sha256!==Buffer.from(checksum,'base64').toString('hex')))throw Error('Local file differs from record');
      const key=process.env.S3_PREFIX+'attachments/'+id;
      const object={Bucket:bucket,Key:key};
      try {
        await s3.send(new PutObjectCommand({...object,IfNoneMatch:'*',ContentLength:size,Body:fs.createReadStream(file),ContentType:'application/octet-stream',ServerSideEncryption:'AES256',ChecksumSHA256:checksum}));
      } catch(e){if(e.$metadata?.httpStatusCode!==412)throw e;}
      const verified=await s3.send(new HeadObjectCommand({...object,ChecksumMode:'ENABLED'}));
      if(verified.ContentLength!==size || verified.ChecksumSHA256!==checksum || verified.ServerSideEncryption!=='AES256' || !verified.VersionId)throw Error('Staged file mismatch');
      console.log(JSON.stringify({key,destination:bucket,destination_version:verified.VersionId,bytes:size,checksum,verified:true,source:'active-disk-fallback'}));
    }
  } finally {s3.destroy();await client.close();}
}
main().catch(e=>{console.error(e.name, e.$metadata?.httpStatusCode ?? e.message);process.exitCode=1;});
