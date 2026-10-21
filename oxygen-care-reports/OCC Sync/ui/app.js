const $=id=>document.getElementById(id);const data=()=>({url:$('url').value.trim(),token:$('token').value.trim()});
function render(s){$('status').textContent=s.status;$('issues').replaceChildren(...s.issues.map(i=>{const li=document.createElement('li');li.textContent=i;return li;}));}
async function run(fn){$('error').textContent='';try{await fn();}catch(e){$('error').textContent=e.message.replace(/^Error invoking remote method '[^']+': Error: /,'');}}
async function refresh(){const s=await window.occ.state();$('setup').hidden=s.connected;$('connected').hidden=!s.connected;$('root').textContent=s.root||'';render(s.status);}
$('load').onclick=()=>run(async()=>{const folders=await window.occ.folders(data());$('folders').replaceChildren(...folders.map(f=>{const l=document.createElement('label'),c=document.createElement('input');c.type='checkbox';c.value=f.id;l.append(c,document.createTextNode(f.name));return l;}));$('connect').hidden=!folders.length;if(!folders.length)$('error').textContent='No shared folders are available.';});
$('connect').onclick=()=>run(async()=>{const roots=[...$('folders').querySelectorAll('input:checked')].map(c=>c.value);if(await window.occ.connect({...data(),roots})){$('token').value='';await refresh();}});
$('open').onclick=()=>run(()=>window.occ.open());$('sync').onclick=()=>run(async()=>render(await window.occ.sync()));$('pause').onclick=()=>run(async()=>{$('pause').textContent=await window.occ.pause()?'Resume':'Pause';});window.occ.onStatus(render);run(refresh);

$('disconnect').onclick=()=>run(async()=>{if(confirm('Disconnect this computer? Your local files remain. Revoke its connection key in IHS Cloud Desktop sync.')){await window.occ.disconnect();await refresh();}});
