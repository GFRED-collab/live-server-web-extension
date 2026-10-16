const {app,BrowserWindow,ipcMain,dialog,safeStorage,shell,powerMonitor}=require('electron');
const fs=require('node:fs/promises');const path=require('node:path');
if(!app.requestSingleInstanceLock())app.quit();
app.on('second-instance',()=>{if(win){win.show();win.focus();}});
let win,engine,config,paused=false,status={status:'Not connected',issues:[]};
const configPath=()=>path.join(app.getPath('userData'),'connection.json');
async function tick(){if(paused||!engine||engine.busy)return;try{status=await engine.cycle()||status;}catch(e){status={status:e.status===401?'Reconnect required':'Offline / unable to sync',issues:[e.message]};}win?.webContents.send('status',status);}
function validUrl(input){const u=new URL(input);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('Enter the HTTPS server address only.');return u.origin;}
async function connectEngine(token){const {SyncEngine}=await import('./engine.mjs');engine=new SyncEngine({...config,token,stateFile:path.join(app.getPath('userData'),'manifest.json')});}
app.whenReady().then(async()=>{
 win=new BrowserWindow({width:780,height:760,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());
 const check=e=>{if(e.sender!==win.webContents||e.senderFrame!==win.webContents.mainFrame)throw Error('Invalid sender');};
 ipcMain.handle('state',async e=>{check(e);return {status,connected:!!config,root:config?.root};});
 ipcMain.handle('folders',async(e,{url,token})=>{check(e);url=validUrl(url);if(!/^occ_[A-Za-z0-9_-]{43}$/.test(token))throw Error('Paste a valid connection key from OCC.');const r=await fetch(url+'/api/sync/snapshot',{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Connection refused. Check the server and connection key.');const s=await r.json();return s.folders.filter(f=>!f.parent).map(f=>({id:f.id,name:f.name}));});
 ipcMain.handle('connect',async(e,{url,token,roots})=>{check(e);if(config)throw Error('Already connected.');url=validUrl(url);if(!/^occ_[A-Za-z0-9_-]{43}$/.test(token)||!Array.isArray(roots)||!roots.length||roots.some(x=>!/^[a-f0-9-]+$/.test(x)))throw Error('Choose at least one folder.');if(!safeStorage.isEncryptionAvailable())throw Error('Operating system secure storage is unavailable.');const picked=await dialog.showOpenDialog(win,{title:'Choose where to create your Oxygen Care Cloud folder',properties:['openDirectory','createDirectory']});if(picked.canceled)return false;const root=path.join(picked.filePaths[0],'Oxygen Care Cloud');await fs.mkdir(root);config={url,roots,root};const encrypted=safeStorage.encryptString(token).toString('base64');await fs.writeFile(configPath(),JSON.stringify({...config,encrypted}),{mode:0o600});await connectEngine(token);await tick();return true;});
 ipcMain.handle('disconnect',async e=>{check(e);if(engine?.busy)throw Error('Wait for syncing to finish.');engine=null;config=null;paused=false;await fs.rm(configPath(),{force:true});await fs.rm(path.join(app.getPath('userData'),'manifest.json'),{force:true});status={status:'Not connected',issues:[]};});
 ipcMain.handle('sync',async e=>{check(e);await tick();return status;});
 ipcMain.handle('pause',e=>{check(e);paused=!paused;return paused;});
 ipcMain.handle('open',async e=>{check(e);if(config)await shell.openPath(config.root);});
 try{const saved=JSON.parse(await fs.readFile(configPath(),'utf8'));const token=safeStorage.decryptString(Buffer.from(saved.encrypted,'base64'));delete saved.encrypted;config=saved;await connectEngine(token);}catch(e){if(e.code!=='ENOENT')status={status:'Unable to reconnect',issues:[e.message]};}
 await win.loadFile(path.join(__dirname,'ui/index.html'));setInterval(tick,30000);powerMonitor.on('resume',tick);await tick();
});
app.on('window-all-closed',()=>app.quit());
