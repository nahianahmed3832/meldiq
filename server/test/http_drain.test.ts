import {afterEach,expect,it} from 'vitest';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import {once} from 'node:events';
import http from 'node:http';
import {installHttpDrain} from '../src/app/httpDrain.js';
const opened:ReturnType<typeof Fastify>[]=[];
afterEach(async()=>{for(const app of opened.splice(0)){app.server.closeAllConnections();await app.close();}});
it('finishes all 24 accepted requests and closes their keep-alive sockets before store teardown',async()=>{
 const app=Fastify();opened.push(app);installHttpDrain(app);await app.register(websocket);
 let release!:()=>void;const barrier=new Promise<void>(r=>release=r);let arrived!:()=>void;const arrival=new Promise<void>(r=>arrived=r);let count=0,committed=0,closed=false;
 app.get('/ws',{websocket:true},()=>{});
 app.get('/work',async()=>{if(++count===24)arrived();await barrier;committed++;return {committed:true};});
 app.addHook('onClose',async()=>{expect(committed).toBe(24);closed=true;});
 const base=await app.listen({host:'127.0.0.1',port:0});
 const ws=new WebSocket(base.replace('http','ws')+'/ws');await once(ws,'open');const wsClosed=once(ws,'close');
 const agent=new http.Agent({keepAlive:true,maxSockets:24});
 const requests=Array.from({length:24},()=>new Promise<number>((resolve,reject)=>{http.get(base+'/work',{agent},res=>{res.resume();res.once('end',()=>resolve(res.statusCode!));}).once('error',reject);}));
 try {
  await arrival;const closing=app.close();await new Promise(r=>setTimeout(r,100));expect(closed).toBe(false);expect(committed).toBe(0);release();
  expect(await Promise.all(requests)).toEqual(Array(24).fill(200));await wsClosed;
  const result=await Promise.race([closing.then(()=>true),new Promise<boolean>(r=>setTimeout(()=>r(false),1000))]);
  expect(result,'completed HTTP responses must not wait for the 72-second keep-alive timeout').toBe(true);expect(closed).toBe(true);
 }finally{release();agent.destroy();ws.terminate();}
});
it('reaps a finished streaming response whose keep-alive headers preceded shutdown',async()=>{
 const app=Fastify();opened.push(app);installHttpDrain(app);
 let finish!:()=>void;const gate=new Promise<void>(r=>finish=r);let started!:()=>void;const start=new Promise<void>(r=>started=r);
 const {PassThrough}=await import('node:stream');
 app.get('/stream',async()=>{const stream=new PassThrough();setImmediate(()=>{stream.write('before');started();void gate.then(()=>stream.end('after'));});return stream;});
 const base=await app.listen({host:'127.0.0.1',port:0});const agent=new http.Agent({keepAlive:true});
 const response=new Promise<string>((resolve,reject)=>{http.get(base+'/stream',{agent},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve(body));}).on('error',reject);});
 try{await start;const closing=app.close();await new Promise(r=>setTimeout(r,50));finish();expect(await response).toBe('beforeafter');expect(await Promise.race([closing.then(()=>true),new Promise(r=>setTimeout(()=>r(false),1000))])).toBe(true);}finally{finish();agent.destroy();}
});
