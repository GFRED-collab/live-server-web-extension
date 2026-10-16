import {fileDigest} from '../sync-api.mjs';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
const dir=resolve(process.argv[2]||process.env.OCC_DATA_DIR||'data');
if(!existsSync(join(dir,'occ.sqlite')))throw Error('The database is missing.');
const db=new DatabaseSync(join(dir,'occ.sqlite'),{readOnly:true});
try{
 if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Database integrity check failed.');
 if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Database foreign-key check failed.');
 const hasHash=db.prepare('PRAGMA table_info(files)').all().some(c=>c.name==='sha256');
 const files=db.prepare('SELECT storage_key,size'+(hasHash?',sha256':'')+' FROM files').all();
 for(const file of files){const path=join(dir,'blobs',file.storage_key);if(!existsSync(path)||statSync(path).size!==file.size)throw Error('A stored file is missing or has the wrong size.');if(file.sha256&&fileDigest(path)!==file.sha256)throw Error('A stored file failed its SHA-256 integrity check.');}
 console.log(JSON.stringify({ok:true,files:files.length,users:db.prepare('SELECT COUNT(*) n FROM users').get().n}));
}finally{db.close()}
