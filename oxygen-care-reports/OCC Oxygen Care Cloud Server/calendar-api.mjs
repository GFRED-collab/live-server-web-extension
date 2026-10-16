import {randomUUID} from 'node:crypto';
// Calendar values are Europe/Dublin wall times, independent of device timezone.
export function createCalendarApi({db,get,all,run,transaction,ensure,json,body,session,audit}){
 db.exec(`CREATE TABLE IF NOT EXISTS bookings(id TEXT PRIMARY KEY,title TEXT NOT NULL,notes TEXT NOT NULL,start TEXT NOT NULL,end TEXT NOT NULL,all_day INTEGER NOT NULL,owner TEXT NOT NULL REFERENCES users(id),revision INTEGER NOT NULL DEFAULT 1,modified INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS booking_dates ON bookings(start,end);`);
 if(!all('PRAGMA table_info(bookings)').some(c=>c.name==='visibility'))db.exec("ALTER TABLE bookings ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'");
 db.exec('CREATE TABLE IF NOT EXISTS booking_groups(booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,group_id TEXT NOT NULL REFERENCES user_groups(id),PRIMARY KEY(booking_id,group_id))');
 const visible=(b,s)=>b.owner===s.user_id||b.visibility==='public'||(b.visibility==='groups'&&!!get('SELECT bg.group_id FROM booking_groups bg JOIN group_members gm ON gm.group_id=bg.group_id WHERE bg.booking_id=? AND gm.user_id=?',b.id,s.user_id));
 function date(v){ensure(typeof v==='string'&&/^20\d\d-\d\d-\d\dT\d\d:\d\d$/.test(v),400,'Enter valid dates between 2000 and 2099.');const d=new Date(v+'Z');ensure(Number.isFinite(d.getTime())&&d.toISOString().slice(0,16)===v,400,'Enter a valid date and time.');return v;}
 const readable=f=>({...f,allDay:!!f.all_day,groupIds:all('SELECT group_id FROM booking_groups WHERE booking_id=?',f.id).map(g=>g.group_id)});
 return async(req,res,url,s)=>{
  if(!url.pathname.startsWith('/api/calendar'))return false;
  if(url.pathname==='/api/calendar'&&req.method==='GET'){
   const from=date(url.searchParams.get('from')),to=date(url.searchParams.get('to'));ensure(from<to&&new Date(to+'Z')-new Date(from+'Z')<=370*86400000,400,'Choose a range of up to one year.');
   json(res,200,{timezone:'Europe/Dublin',bookings:all('SELECT b.*,u.name ownerName FROM bookings b JOIN users u ON u.id=b.owner WHERE b.start<? AND b.end>? ORDER BY b.start',to,from).filter(b=>visible(b,s)).map(readable)});return true;
  }
  const match=url.pathname.match(/^\/api\/calendar\/([a-f0-9-]{36})$/),id=match?.[1];
  ensure((!id&&url.pathname==='/api/calendar'&&req.method==='POST')||(id&&['PUT','DELETE'].includes(req.method)),404,'Calendar operation not found.');
  const data=await body(req);const fresh=session(req);ensure(fresh&&!fresh.must_change,401,'Sign in again.');
  const result=transaction(()=>{
   const old=id?get('SELECT * FROM bookings WHERE id=?',id):null;
   if(id){ensure(old&&visible(old,fresh),404,'Booking not found.');ensure(old.owner===fresh.user_id||fresh.account==='super',403,'Only the booking owner or a Super User can change this booking.');ensure(data.revision===old.revision,409,'This booking changed. Refresh the calendar before trying again.');}
   if(req.method==='DELETE'){run('DELETE FROM bookings WHERE id=?',id);audit(fresh.user_id,'calendar.deleted',id);return {ok:true};}
   ensure(typeof data.title==='string'&&data.title.trim().length>0&&data.title.trim().length<=160,400,'Enter a title of 1–160 characters.');ensure(typeof data.notes==='string'&&data.notes.length<=4000,400,'Notes must be no longer than 4,000 characters.');ensure(typeof data.allDay==='boolean',400,'Choose a booking type.');
   const start=date(data.start),end=date(data.end);ensure(start<end,400,'The end must be after the start.');ensure(new Date(end+'Z')-new Date(start+'Z')<=366*86400000,400,'Bookings can span up to one year.');if(data.allDay)ensure(start.endsWith('T00:00')&&end.endsWith('T00:00'),400,'All-day bookings must use whole dates.');
   const visibility=data.visibility??old?.visibility??'public';ensure(['public','private','groups'].includes(visibility),400,'Choose a valid visibility.');const groups=visibility==='groups'?data.groupIds:[];ensure(Array.isArray(groups)&&groups.length<=100&&(visibility!=='groups'||groups.length>0),400,'Choose at least one user group.');for(const group of groups)ensure(typeof group==='string'&&get('SELECT id FROM user_groups WHERE id=?',group)&&(fresh.account==='super'||get('SELECT user_id FROM group_members WHERE group_id=? AND user_id=?',group,fresh.user_id)),403,'Group access is unavailable.');
   ensure(!all('SELECT * FROM bookings WHERE start<? AND end>? AND id<>?',end,start,id||'').some(b=>visible(b,fresh)),409,'These dates overlap an existing booking. Choose another time.');
   const key=id||randomUUID();if(id)run('UPDATE bookings SET title=?,notes=?,start=?,end=?,all_day=?,revision=revision+1,modified=? WHERE id=?',data.title.trim(),data.notes.trim(),start,end,Number(data.allDay),Date.now(),id);
   else run('INSERT INTO bookings(id,title,notes,start,end,all_day,owner,modified) VALUES(?,?,?,?,?,?,?,?)',key,data.title.trim(),data.notes.trim(),start,end,Number(data.allDay),fresh.user_id,Date.now());
   run('UPDATE bookings SET visibility=? WHERE id=?',visibility,key);run('DELETE FROM booking_groups WHERE booking_id=?',key);for(const group of new Set(groups))run('INSERT INTO booking_groups VALUES(?,?)',key,group);
   audit(fresh.user_id,id?'calendar.updated':'calendar.created',key);return {id:key};
  });json(res,id?200:201,result);return true;
 };
}
