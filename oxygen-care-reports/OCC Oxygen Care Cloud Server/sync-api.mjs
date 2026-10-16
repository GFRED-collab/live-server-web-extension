import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {openSync,readSync,closeSync,createReadStream} from 'node:fs';
import {open,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';

export function fileDigest(path){const fd=openSync(path,'r');const digest=createHash('sha256'),buffer=Buffer.alloc(65536);try{let size;while((size=readSync(fd,buffer,0,buffer.length,null))>0)digest.update(buffer.subarray(0,size));return digest.digest('hex')}finally{closeSync(fd)}}
export function createSyncApi(c){
  const {db,get,all,run,transaction,ensure,json,body,name,audit,dataDir,maxFile,quota,permits,requireFolder,requireFile,detectMime,acquireUpload,releaseUpload}=c;
  const digest=s=>createHash('sha256').update(s).digest('hex');
  const version=Number(get("SELECT value FROM settings WHERE key='schema_version'").value);
  ensure(version<=2,500,'This database requires a newer OCC server.');
  transaction(()=>{
    const columns=new Set(all('PRAGMA table_info(files)').map(x=>x.name));
    if(!columns.has('revision'))db.exec('ALTER TABLE files ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
    if(!columns.has('sha256'))db.exec("ALTER TABLE files ADD COLUMN sha256 TEXT NOT NULL DEFAULT ''");
    db.exec(`CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,created INTEGER NOT NULL,expires INTEGER NOT NULL,last_seen INTEGER,revoked INTEGER NOT NULL DEFAULT 0);`);
    run("UPDATE settings SET value='2' WHERE key='schema_version'");
  });
  function device(req){const token=req.headers.authorization?.match(/^Bearer (occ_[A-Za-z0-9_-]{43})$/)?.[1];if(!token)return null;const s=get('SELECT d.id device_id,d.user_id,d.expires,d.revoked,u.account,u.active,u.must_change,u.name,u.email FROM devices d JOIN users u ON u.id=d.user_id WHERE d.token_hash=?',digest(token));if(!s||s.revoked||!s.active||s.must_change||s.expires<Date.now())return null;run('UPDATE devices SET last_seen=? WHERE id=?',Date.now(),s.device_id);return s;}
  const matchVersion=(req,f)=>ensure(req.headers['if-match']===`"${f.revision}"`,req.headers['if-match']?412:428,'This file changed on OCC. Keep both copies and retry.','VERSION_CONFLICT');
  const describe=f=>({id:f.id,name:f.name,folder:f.folder,size:f.size,mime:f.mime,modified:f.modified,revision:f.revision,sha256:f.sha256});
  function hashed(f){if(!f.sha256){const value=fileDigest(join(dataDir,'blobs',f.storage_key));run('UPDATE files SET sha256=? WHERE id=?',value,f.id);f.sha256=value;}return f;}
  async function account(req,res,url,s){
    if(url.pathname==='/api/devices'&&req.method==='GET'){
      return json(res,200,{devices:all('SELECT id,name,created,expires,last_seen,revoked FROM devices WHERE user_id=? ORDER BY created DESC',s.user_id)}),true;
    }
    if(url.pathname==='/api/devices'&&req.method==='POST'){
      const data=await body(req);const label=name(data.name);
      ensure(get('SELECT COUNT(*) n FROM devices WHERE user_id=? AND revoked=0 AND expires>?',s.user_id,Date.now()).n<10,409,'Disconnect an old computer before adding another.');
      const id=randomUUID(),token='occ_'+randomBytes(32).toString('base64url'),expires=Date.now()+90*86400000;
      transaction(()=>{run('INSERT INTO devices VALUES(?,?,?,?,?,?,NULL,0)',id,s.user_id,label,digest(token),Date.now(),expires);audit(s.user_id,'device.connected',id,{name:label});});
      return json(res,201,{id,name:label,token,expires}),true;
    }
    const m=url.pathname.match(/^\/api\/devices\/([a-f0-9-]+)$/);
    if(m&&req.method==='DELETE'){
      const d=get('SELECT user_id FROM devices WHERE id=?',m[1]);ensure(d&&d.user_id===s.user_id,404,'Computer not found.');run('UPDATE devices SET revoked=1 WHERE id=?',m[1]);audit(s.user_id,'device.disconnected',m[1]);return json(res,200,{ok:true}),true;
    }
    return false;
  }
  async function handle(req,res,url){
    if(!url.pathname.startsWith('/api/sync/'))return false;
    const s=device(req);ensure(s,401,'Reconnect this computer from your OCC account.','DEVICE_RECONNECT_REQUIRED');
    if(url.pathname==='/api/sync/snapshot'&&req.method==='GET'){
      const folders=all('SELECT * FROM folders').filter(f=>permits(s,f.id)).map(f=>({...f,permission:c.permission(s,f.id)}));const ids=new Set(folders.map(f=>f.id));
      const files=all('SELECT * FROM files').filter(f=>ids.has(f.folder)).map(f=>describe(hashed(f)));
      json(res,200,{protocol:1,user:{id:s.user_id,name:s.name},deviceId:s.device_id,folders,files,maxFileBytes:maxFile});return true;
    }
    if(url.pathname==='/api/sync/folders'&&req.method==='POST'){
      const data=await body(req);const fresh=device(req);ensure(fresh,401,'Reconnect this computer.');requireFolder(fresh,data.parent,'upload');const n=name(data.name);
      const found=get('SELECT id FROM folders WHERE parent=? AND LOWER(name)=LOWER(?)',data.parent,n);if(found){json(res,200,{id:found.id});return true;}
      const id=randomUUID();transaction(()=>{run('INSERT INTO folders VALUES(?,?,?,?,?)',id,n,data.parent,s.user_id,Date.now());audit(s.user_id,'folder.created',id,{name:n,device:s.device_id});});json(res,201,{id});return true;
    }
    let m=url.pathname.match(/^\/api\/sync\/files\/([a-f0-9-]+)\/content$/);
    if(m&&req.method==='GET'){
      const f=hashed(requireFile(s,m[1]));matchVersion(req,f);
      res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Length',f.size);res.setHeader('ETag',`"${f.revision}"`);res.setHeader('X-OCC-SHA256',f.sha256);res.setHeader('Content-Disposition','attachment');
      const stream=createReadStream(join(dataDir,'blobs',f.storage_key));stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return true;
    }
    m=url.pathname.match(/^\/api\/sync\/files\/([a-f0-9-]+)$/);
    if(m&&req.method==='DELETE'){
      const f=requireFile(s,m[1],'manage');matchVersion(req,f);transaction(()=>{run('DELETE FROM files WHERE id=?',f.id);audit(s.user_id,'file.deleted',f.id,{name:f.name,device:s.device_id});});await unlink(join(dataDir,'blobs',f.storage_key)).catch(()=>{});json(res,200,{ok:true});return true;
    }
    if((url.pathname==='/api/sync/files'&&req.method==='POST')||(m&&req.method==='PUT')){
      const previous=m?requireFile(s,m[1],'manage'):null;
      if(previous)matchVersion(req,previous);
      const folder=previous?.folder||url.searchParams.get('folder'),n=previous?.name||name(url.searchParams.get('name'));requireFolder(s,folder,previous?'manage':'upload');
      if(!previous)ensure(!get('SELECT id FROM files WHERE folder=? AND LOWER(name)=LOWER(?)',folder,n)&&!get('SELECT id FROM file_references WHERE folder=? AND LOWER(name)=LOWER(?)',folder,n),409,'A file with this name already exists.');
      ensure(Number(req.headers['content-length']||0)<=maxFile,413,'This file exceeds the upload limit.');acquireUpload(s.user_id);
      const key=randomUUID(),tmp=join(dataDir,'blobs',key+'.tmp'),destination=join(dataDir,'blobs',key);let handle,size=0,committed=false;const sha=createHash('sha256');
      try{
        handle=await open(tmp,'wx',0o600);
        for await(const chunk of req){size+=chunk.length;ensure(size<=maxFile,413,'This file exceeds the upload limit.');sha.update(chunk);for(let at=0;at<chunk.length;){const {bytesWritten}=await handle.write(chunk,at,chunk.length-at);ensure(bytesWritten>0,500,'Unable to save the file.');at+=bytesWritten;}}
        await handle.sync();await handle.close();handle=null;
        const fresh=device(req);ensure(fresh,401,'Reconnect this computer.');requireFolder(fresh,folder,previous?'manage':'upload');if(previous)matchVersion(req,requireFile(fresh,previous.id,'manage'));
        const mime=detectMime(tmp),hash=sha.digest('hex'),id=previous?.id||randomUUID();await rename(tmp,destination);const directory=await open(join(dataDir,'blobs'),'r');try{await directory.sync()}finally{await directory.close()}
        transaction(()=>{
          const committedDevice=device(req);ensure(committedDevice,401,'Reconnect this computer.');requireFolder(committedDevice,folder,previous?'manage':'upload');
          const current=previous?requireFile(committedDevice,id,'manage'):null;if(current)matchVersion(req,current);
          ensure(get('SELECT COALESCE(SUM(size),0) n FROM files').n-(current?.size||0)+size<=quota,413,'Workspace storage is full.');
          if(previous)run('UPDATE files SET storage_key=?,size=?,mime=?,modified=?,revision=revision+1,sha256=? WHERE id=?',key,size,mime,Date.now(),hash,id);
          else run('INSERT INTO files(id,name,folder,storage_key,size,mime,owner,modified,revision,sha256) VALUES(?,?,?,?,?,?,?,?,1,?)',id,n,folder,key,size,mime,s.user_id,Date.now(),hash);
          audit(s.user_id,previous?'file.content_updated':'file.uploaded',id,{name:n,size,device:s.device_id});
        });committed=true;if(previous)await unlink(join(dataDir,'blobs',previous.storage_key)).catch(()=>{});
        json(res,previous?200:201,{file:describe(get('SELECT * FROM files WHERE id=?',id))});return true;
      }finally{if(handle)await handle.close().catch(()=>{});if(!committed){await unlink(tmp).catch(()=>{});await unlink(destination).catch(()=>{})}releaseUpload(s.user_id);}
    }
    ensure(false,404,'Sync operation not found.');
  }
  return {account,handle};
}
