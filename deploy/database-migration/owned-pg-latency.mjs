import net from "node:net";
import fs from "node:fs";
if(process.env.MELDIQ_OWNED_CANARY!=="synthetic-loopback")throw new Error("Owned canary only");
const delay=84;
const server=net.createServer(front=>{
  const back=net.createConnection({host:"127.0.0.1",port:5432});
  front.setNoDelay(true);back.setNoDelay(true);
  const timers=new Set();
  const forward=(source,target)=>source.on("data",data=>{
    source.pause();
    const timer=setTimeout(()=>{timers.delete(timer);if(!target.destroyed)target.write(data,()=>source.resume());},delay);timers.add(timer);
  });
  forward(front,back);forward(back,front);
  const stop=()=>{for(const timer of timers)clearTimeout(timer);front.destroy();back.destroy();};
  front.on("error",stop);back.on("error",stop);front.on("end",()=>back.end());back.on("end",()=>front.end());front.on("close",stop);back.on("close",stop);
});
server.listen(55433,"127.0.0.1",()=>fs.writeFileSync("/control/proxy-ready.json",JSON.stringify({ready:true,simulatedRoundTripMilliseconds:168})+"\n"));
process.on("SIGTERM",()=>server.close(()=>process.exit(0)));
