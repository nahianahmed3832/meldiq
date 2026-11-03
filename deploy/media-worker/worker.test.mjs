import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deliver} from './worker.mjs';
const env={MEDIA_EDGE_SECRET:'test',S3_ORIGIN:'https://private.example',S3_PREFIX:'orbit/'};
const req=(path,options)=>new Request('https://media.meldiq.app'+path,options);
const path='/attachments/a?ticket=grant';
const location=env.S3_ORIGIN+'/orbit/attachments/a?X-Amz-Signature=test';
test('private ranges stream and edge credentials never reach storage',async()=>{
  const calls=[];
  const response=await deliver(req(path,{headers:{Range:'bytes=0-2',Cookie:'private'}}),env,async(url,options)=>{
    calls.push(url);
    assert.equal(options.cache,'no-store');
    if(calls.length===1) return new Response(null,{status:302,headers:{location}});
    assert.equal(options.headers.get('range'),'bytes=0-2');
    assert.equal(options.headers.get('cookie'),null);
    assert.equal(options.headers.get('x-meldiq-edge-key'),null);
    return new Response('abc',{status:206,headers:{'content-range':'bytes 0-2/9','content-type':'video/mp4'}});
  });
  assert.equal(response.status,206);assert.equal(await response.text(),'abc');assert.equal(response.headers.get('cache-control'),'private, no-store');
});
test('malformed paths and missing tickets never contact an origin',async()=>{
  for (const url of ['/attachments/a','/attachments/a/b?ticket=ok','/attachments/%2F?ticket=ok']){
    assert.equal((await deliver(req(url),env,()=>assert.fail())).status,404);
  }
});
test('revocation and substituted origins fail closed',async()=>{
  for (const [upstream,expected] of [[new Response(null,{status:404}),404],[new Response(null,{status:302,headers:{location:'https://other.example'}}),502]]){
    assert.equal((await deliver(req(path),env,async()=>upstream)).status,expected);
  }
});
test('HEAD is signed as HEAD and returns no body',async()=>{
  const r=await deliver(req(path,{method:'HEAD'}),env,async(url,options)=>{
    if(url===location){assert.equal(options.method,'HEAD');return new Response(null,{headers:{'content-length':'100'}});}
    assert.equal(options.headers['x-meldiq-media-method'],'HEAD');
    return new Response(null,{status:302,headers:{location}});
  });
  assert.equal(r.headers.get('content-length'),'100');assert.equal(await r.text(),'');
});
