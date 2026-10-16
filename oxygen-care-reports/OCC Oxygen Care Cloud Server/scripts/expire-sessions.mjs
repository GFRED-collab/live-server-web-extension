import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
const file=join(resolve(process.argv[2]||process.env.OCC_DATA_DIR||'data'),'occ.sqlite');
if(!existsSync(file))throw Error('Database does not exist.');
const db=new DatabaseSync(file);try{const result=db.prepare('DELETE FROM sessions').run();if(db.prepare("SELECT name FROM sqlite_master WHERE name='devices'").get())db.prepare('UPDATE devices SET revoked=1').run();console.log(`Expired ${result.changes} sessions.`)}finally{db.close()}
