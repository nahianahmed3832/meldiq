import {expect,it,vi} from 'vitest';
import {startJobs} from '../src/modules/administration/jobs.js';
import {Hub} from '../src/modules/realtime/hub.js';
import type {AppContext} from '../src/app/context.js';
import type {RelayStore} from '../src/modules/messaging/index.js';
it('stops scheduling cleanup and awaits the active job',async()=>{
 vi.useFakeTimers();let release!:()=>void;let calls=0;
 const pending=new Promise<Record<string,number>>(r=>release=()=>r({queue:1}));
 const ctx={config:{cleanupIntervalSeconds:1},metrics:{timeJob:()=>{calls++;return pending;}},log:{info:()=>{},error:()=>{}}} as unknown as AppContext;
 try {const stop=startJobs(ctx);await vi.advanceTimersByTimeAsync(1000);expect(calls).toBe(1);let done=false;const stopped=stop().then(()=>done=true);await vi.advanceTimersByTimeAsync(5000);expect(calls).toBe(1);expect(done).toBe(false);release();await stopped;expect(done).toBe(true);}finally{release();vi.useRealTimers();}
});
it('awaits queued device work, including work appended by an existing frame',async()=>{
 const hub=new Hub({} as RelayStore);let release!:()=>void;const gate=new Promise<void>(r=>release=r);const completed:string[]=[];
 const first=hub.onDevice('one',async()=>{await gate;completed.push('first');void hub.onDevice('one',async()=>{completed.push('second');});});
 let done=false;const settled=hub.settled().then(()=>done=true);await Promise.resolve();expect(done).toBe(false);release();await first;await settled;expect(completed).toEqual(['first','second']);hub.closePresence();
});
