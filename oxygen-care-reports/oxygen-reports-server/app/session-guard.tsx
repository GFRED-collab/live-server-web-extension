'use client';
import {useEffect} from 'react';

export default function SessionGuard(){
 useEffect(()=>{
  let active=false,stopped=false,expired=false,deadline=0,lastActivitySent=0,pending=false,sequence=0;
  let expiryTimer:ReturnType<typeof setTimeout>|undefined;
  function expire(){
   if(expired||stopped)return;expired=true;active=false;
   // Remove sensitive rendered content immediately, including when the network fails.
   document.body.replaceChildren();
   void fetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',keepalive:true}).catch(()=>undefined);
   window.location.replace('/?session=expired');
  }
  function remember(remaining:unknown){
   const duration=Number(remaining);
   if(!Number.isFinite(duration)||duration<=0){expire();return;}
   active=true;deadline=Date.now()+Math.min(duration,15*60*1000);
   clearTimeout(expiryTimer);expiryTimer=setTimeout(()=>void check(),Math.max(1,deadline-Date.now()));
  }
  async function check(){
   if(stopped||expired)return;
   const request=++sequence;
   try{
    const response=await fetch('/api/auth/me',{cache:'no-store',signal:AbortSignal.timeout(5000)});
    if(stopped||expired||request!==sequence)return;
    if(response.status===401){if(active||window.location.pathname!=='/')expire();return;}
    if(!response.ok)throw Error('Session check failed');
    const data=await response.json();if(!stopped&&!expired&&request===sequence)remember(data.user.sessionRemainingMs);
   }catch{if(request===sequence&&active&&Date.now()>=deadline)expire();}
  }
  function activity(event:Event){
   if(!active||stopped||expired||!event.isTrusted||document.visibilityState!=='visible')return;
   if(Date.now()>=deadline){void check();return;}
   if(pending||Date.now()-lastActivitySent<30000)return;
   pending=true;lastActivitySent=Date.now();
   void fetch('/api/auth/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)}).then(async response=>{
    if(stopped||expired)return;
    if(response.status===401){expire();return;}
    if(response.ok){const data=await response.json();if(!stopped&&!expired)remember(data.sessionRemainingMs);}
   }).catch(()=>undefined).finally(()=>{pending=false;});
  }
  const visible=()=>{if(document.visibilityState==='visible')void check();};
  const signedIn=()=>{lastActivitySent=0;void check();};
  const signedOut=()=>{++sequence;active=false;clearTimeout(expiryTimer);};
  const events=['pointerdown','pointermove','keydown','scroll'];
  for(const name of events)window.addEventListener(name,activity,{passive:true,capture:true});
  window.addEventListener('session-signed-in',signedIn);window.addEventListener('session-signed-out',signedOut);
  document.addEventListener('visibilitychange',visible);
  const poll=setInterval(()=>void check(),30000);void check();
  return()=>{stopped=true;clearTimeout(expiryTimer);clearInterval(poll);for(const name of events)window.removeEventListener(name,activity,true);window.removeEventListener('session-signed-in',signedIn);window.removeEventListener('session-signed-out',signedOut);document.removeEventListener('visibilitychange',visible);};
 },[]);
 return null;
}
