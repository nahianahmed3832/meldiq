// Execute inside the API container. Only aggregate counts leave the process.
const { MongoClient } = require('mongodb');
async function main() {
  const client = new MongoClient(process.env.MONGODB_URI, { appName:'meldiq-readonly-media-audit', maxPoolSize:1, serverSelectionTimeoutMS:5000 });
  try {
    const db=client.db(process.env.MONGODB_DB);
    const bucket=process.env.S3_BUCKET;
    if (!bucket) throw Error('Missing active bucket');
    const region=process.env.S3_REGION;
    const hosts=new Set(['s3.amazonaws.com','s3.'+region+'.amazonaws.com','s3-'+region+'.amazonaws.com']);
    const bucketHosts=new Set([...hosts].map(host=>bucket+'.'+host));
    function inspect(value,counts) {
      if (typeof value==='string') {
        for (const candidate of value.match(/https?:\/\/[^\s"<>\\]+/gi)??[]) {
          try {
            const url=new URL(candidate);
            if (bucketHosts.has(url.hostname)||(hosts.has(url.hostname)&&url.pathname.startsWith('/'+bucket+'/'))) {
              counts.sourceReferences++;
              if (url.searchParams.has('X-Amz-Signature')) counts.signed++;
            }
          } catch {}
        }
      } else if (value && typeof value==='object' && !Buffer.isBuffer(value) && !value._bsontype && !(value instanceof Date)) {
        for(const child of Object.values(value)) inspect(child,counts);
      }
    }
    for(const {name} of await db.listCollections({},{nameOnly:true}).toArray()) {
      if (!/attachment|file|media|message|envelope|relay|history|photo|profile|sticker|emoji|preview|upload|conversation|channel|community|asset/i.test(name)) continue;
      const counts={collection:name,documents:0,sourceReferences:0,signed:0};
      for await(const doc of db.collection(name).find({},{maxTimeMS:60000,batchSize:100})) { counts.documents++;inspect(doc,counts); }
      console.log(JSON.stringify(counts));
    }
  } finally { await client.close(); }
}
main().catch(()=>{console.error('Read-only scan failed');process.exitCode=1;});
