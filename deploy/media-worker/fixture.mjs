import { AwsClient } from 'aws4fetch';
export const FIXTURE = 'Meldiq Frankfurt origin check v1\n';
export async function readFixture(env, fetcher) {
  const client = new AwsClient({accessKeyId:env.PROBE_KEY_ID,secretAccessKey:env.PROBE_KEY_SECRET,region:'eu-central-1',service:'s3'});
  const signed = await client.sign(env.S3_ORIGIN+'/orbit/__status-monitoring/frankfurt-origin-v1.txt', {headers:{range:'bytes=0-'+(FIXTURE.length-1)}});
  const r = await fetcher(signed,{redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(5000)});
  if (r.status !== 206) { await r.body?.cancel(); throw Error('origin_http_'+r.status); }
  if (r.headers.get('content-range') !== 'bytes 0-'+(FIXTURE.length-1)+'/'+FIXTURE.length || await r.text() !== FIXTURE) throw Error('fixture_mismatch');
}
