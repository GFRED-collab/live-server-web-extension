// Emergency: clears one account's authenticator so it is set up again at the next sign-in.
// Usage (as the service user): node scripts/reset-mfa.mjs person@example.com [data directory]
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
const email=String(process.argv[2]||'').trim().toLowerCase();
if(!email.includes('@'))throw Error('Give the email address of the account to reset.');
const file=join(resolve(process.argv[3]||process.env.OCC_DATA_DIR||'data'),'occ.sqlite');
if(!existsSync(file))throw Error('Database does not exist.');
const db=new DatabaseSync(file);db.exec('PRAGMA busy_timeout=5000');
try{
 const user=db.prepare('SELECT id FROM users WHERE email=?').get(email);if(!user)throw Error('No account uses that email address.');
 db.exec('BEGIN IMMEDIATE');
 try{db.prepare("UPDATE users SET mfa_secret=NULL,mfa_enabled_at=NULL,mfa_last_step=NULL,mfa_recovery='[]' WHERE id=?").run(user.id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);db.prepare("DELETE FROM login_challenges WHERE user_id=?").run(user.id);db.prepare('INSERT INTO audit(at,actor,action,target,detail) VALUES(?,?,?,?,?)').run(Date.now(),null,'user.mfa_reset',user.id,JSON.stringify({by:'server script'}));db.exec('COMMIT');}
 catch(error){db.exec('ROLLBACK');throw error;}
 console.log(`Authenticator cleared for ${email}. They set it up again at their next sign-in.`);
}finally{db.close()}
