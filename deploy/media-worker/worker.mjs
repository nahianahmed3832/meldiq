import { FIXTURE, readFixture } from "./fixture.mjs";

// The API issues a presigned request only after checking current membership,
// publication state, session validity and quota. No AWS credential at the edge.
export async function deliver(request, env, fetcher = fetch) {
  const url = new URL(request.url);
  const headers = new Headers({'Cache-Control':'private, no-store','CDN-Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Vary':'Origin'});
  const finish = status => new Response(null, {status,headers});
  // Only this fixed, deliberately public fixture may enter the shared cache.
  const fixturePath = '/public/origin-v1.txt';
  if (url.pathname === '/healthz' || url.pathname === fixturePath) {
    if (!['GET','HEAD'].includes(request.method)) return finish(405);
    const immutable = url.pathname === fixturePath;
    const cache = immutable && globalThis.caches?.default;
    const cacheKey = new Request(url.origin+fixturePath);
    try {
      let response = cache && await cache.match(cacheKey);
      if (!response) {
        await readFixture(env,fetcher);
        response = immutable
          ? new Response(FIXTURE,{headers:{'content-type':'text/plain','cache-control':'public, max-age=31536000, immutable'}})
          : Response.json({ok:true},{headers});
        if (cache) await cache.put(cacheKey,response.clone());
      }
      return request.method === 'HEAD' ? new Response(null,{status:response.status,headers:response.headers}) : response;
    } catch (error) {
      const reason = /^(origin_http_[0-9]{3}|fixture_mismatch)$/.test(error.message) ? error.message : 'origin_unavailable';
      return Response.json({ok:false,reason},{status:503,headers});
    }
  }
  const id = /^\/attachments\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname)?.[1];
  if (!id) return finish(404);
  const origin = request.headers.get('origin');
  if (origin && ['https://web.meldiq.app','https://admin.meldiq.app'].includes(origin)) {
    headers.set('Access-Control-Allow-Origin',origin);
    headers.set('Access-Control-Allow-Methods','GET, HEAD, OPTIONS');
    headers.set('Access-Control-Allow-Headers','Range, If-Range, If-None-Match, If-Modified-Since, If-Match, If-Unmodified-Since');
    headers.set('Access-Control-Expose-Headers','ETag, Accept-Ranges, Content-Range, Content-Length, Last-Modified');
  }
  if (request.method === 'OPTIONS') return finish(headers.has('Access-Control-Allow-Origin') ? 204 : 403);
  if (!['GET','HEAD'].includes(request.method)) return finish(405);
  const ticket = url.searchParams.get('ticket');
  if (!ticket || ticket.length > 14000 || !/^[A-Za-z0-9_-]+$/.test(ticket)) return finish(404);
  if (!env.MEDIA_EDGE_SECRET || !env.S3_ORIGIN || !env.S3_PREFIX) return finish(503);
  // Ignore the Range when If-Range is present. A complete representation is safe
  // without a validated range and must be charged as a full download.
  const range = request.headers.has('if-range') ? null : request.headers.get('range');
  if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) return finish(416);
  const options = {redirect:'manual',cache:'no-store'};
  try {
    const auth = await fetcher('https://msg.meldiq.app/v1/attachments/'+id, {...options,signal:AbortSignal.timeout(8000),headers:{
      'x-meldiq-media-grant':ticket,'x-meldiq-edge-key':env.MEDIA_EDGE_SECRET,'x-meldiq-media-method':request.method,...(range ? {range} : {})
    }});
    await auth.body?.cancel();
    if (auth.status !== 302) return finish([401,403,404,429].includes(auth.status) ? auth.status : 502);
    const signed = new URL(auth.headers.get('location'));
    if (signed.origin !== env.S3_ORIGIN || signed.username || signed.password || signed.pathname !== '/'+env.S3_PREFIX+'attachments/'+id ||
        !signed.searchParams.has('X-Amz-Signature')) return finish(502);
    const forward = new Headers();
    for (const key of ['range','if-none-match','if-modified-since','if-match','if-unmodified-since']) {
      if (request.headers.has(key)) forward.set(key,request.headers.get(key));
    }
    if (!range) forward.delete('range');
    const response = await fetcher(signed.href,{...options,method:request.method,headers:forward,signal:request.signal});
    if (![200,206,304,412,416].includes(response.status)) {
      await response.body?.cancel();
      return finish(response.status===404 ? 404 : 502);
    }
    for (const key of ['accept-ranges','content-length','content-range','content-type','content-encoding','content-disposition','etag','last-modified']) {
      if (response.headers.has(key)) headers.set(key,response.headers.get(key));
    }
    return new Response(response.body,{status:response.status,headers});
  } catch { return finish(502); }
}
export default {fetch: (request, env) => deliver(request, env)};
