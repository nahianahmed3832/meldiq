// A bounded FIFO delay line. Preserve stream throughput; do not charge a whole RTT per socket read.
import net from 'node:net';
import fs from 'node:fs';
if(process.env.MELDIQ_OWNED_CANARY!=='synthetic-loopback')throw Error('owned staging only');
const rtt=Number(process.env.MELDIQ_CANARY_DATABASE_RTT_MS);
if(![2,168].includes(rtt))throw Error('unsupported RTT');
const bandwidth=12*1024*1024/1000;
net.createServer(front=>{
 const back=net.createConnection({host:'127.0.0.1',port:5432});
 front.setNoDelay();back.setNoDelay();
 const stops=[];
 function line(source,target){
   const held=[];let size=0,when=0,timer,busy=false,ended=false;
   function flush(){
     if(busy||timer||target.destroyed)return;
     if(!held.length){if(ended)target.end();return;}
     const wait=held[0].at-performance.now();
     if(wait>1){timer=setTimeout(()=>{timer=null;flush();},wait);return;}
     const {chunk}=held.shift();size-=chunk.length;busy=true;
     target.write(chunk,()=>{busy=false;if(size<2*1024*1024&&!ended)source.resume();flush();});
   }
   source.on('data',chunk=>{when=Math.max(when,performance.now()+rtt/2)+chunk.length/bandwidth;
     held.push({at:when,chunk});size+=chunk.length;if(size>=4*1024*1024)source.pause();flush();});
   source.on('end',()=>{ended=true;flush();});
   stops.push(()=>{clearTimeout(timer);held.length=0;});
 }
 line(front,back);line(back,front);
 const stop=()=>{for(const fn of stops)fn();front.destroy();back.destroy();};
 front.on('error',stop);back.on('error',stop);front.on('close',stop);back.on('close',stop);
}).listen(55433,'127.0.0.1',()=>fs.writeFileSync('/control/proxy-ready.json',JSON.stringify({rtt,MiBps:12})));
