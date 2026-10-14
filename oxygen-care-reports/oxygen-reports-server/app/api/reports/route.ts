import { writeAudit } from '../../../lib/audit';
import { requireUser } from '../../../lib/auth';
import { getDb } from '../../../lib/db';
import { errorResponse, jsonObject } from '../../../lib/http';
import {serviceStatus} from '../../../lib/service-status';
import {reviewImport,normalizedIdentifier} from '../../../lib/import-duplicates';

export async function GET() {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  const user = auth.user!;
  const params: unknown[] = [];
  let where = '';
  if (user.role !== 'super_user') {
    params.push(user.id);
    where = 'WHERE EXISTS(SELECT 1 FROM report_assignments a WHERE a.report_id=r.id AND a.user_id=$1)';
  }
  const result = await getDb().query(
    `SELECT r.id,r.client_name AS "clientName",r.original_filename AS "originalFilename",r.uploaded_at AS "uploadedAt",
            COALESCE(jsonb_agg(DISTINCT a.user_id) FILTER(WHERE a.user_id IS NOT NULL),'[]') AS "userIds",
            count(DISTINCT rr.id)::int AS "rowCount"
       FROM reports r
       LEFT JOIN report_assignments a ON a.report_id=r.id
       LEFT JOIN report_rows rr ON rr.report_id=r.id
       ${where}
      GROUP BY r.id ORDER BY r.uploaded_at DESC`, params,
  );
  return Response.json({ reports: result.rows });
}

export async function POST(request: Request) {
 const auth=await requireUser(['super_user']);if(auth.response)return auth.response;
 try{
  const body=await jsonObject(request),visitId=String(body.serviceVisitId||''),filename=String(body.originalFilename||'').trim();
  const rows=Array.isArray(body.rows)?body.rows as Record<string,unknown>[]:[],userIds=Array.isArray(body.userIds)?body.userIds.map(String):[];
  if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(visitId))throw Error('Choose a service visit before importing.');
  if(!filename||filename.length>255||!rows.length||rows.length>10000||rows.some(row=>!row||typeof row!=='object'||Array.isArray(row)))throw Error('Choose a report containing 1–10,000 data rows.');
  const db=await getDb().connect();
  try{
   await db.query('BEGIN');
   const found=await db.query('SELECT v.status,v.contract_id,v.service_date::text,ct.client_id,c.name AS client_name FROM service_visits v JOIN contracts ct ON ct.id=v.contract_id JOIN clients c ON c.id=ct.client_id WHERE v.id=$1 FOR UPDATE OF v',[visitId]);
   if(!found.rowCount)throw Error('Service visit not found.');
   const visit=found.rows[0];if(visit.status!=='draft')throw Error('Finalized service visits cannot receive imports.');
   if(String(body.clientName||'').trim().toLowerCase()!==visit.client_name.trim().toLowerCase())throw Error('The report client must match the selected service visit.');
   await db.query('SELECT id FROM clients WHERE id=$1 FOR UPDATE',[visit.client_id]);
   const existing=await db.query(`SELECT d.serial_number AS "serialNumber",d.asset_number AS "assetNumber" FROM service_visit_devices sd JOIN devices d ON d.id=sd.device_id WHERE sd.service_visit_id=$1
    UNION ALL SELECT rr.serial_number,rr.asset_number FROM report_rows rr JOIN reports r ON r.id=rr.report_id LEFT JOIN service_visits legacy ON legacy.source_report_id=r.id WHERE COALESCE(r.service_visit_id,legacy.id)=$1`,[visitId]);
   const review=reviewImport(rows,existing.rows);
   const registry=await db.query(`SELECT d.id,d.serial_number AS "serialNumber",d.asset_number AS "assetNumber",d.status,cd.added_on::text,cd.removed_on::text,cd.contract_id FROM devices d LEFT JOIN contract_devices cd ON cd.device_id=d.id AND cd.contract_id=$2 WHERE d.client_id=$1`,[visit.client_id,visit.contract_id]);
   const serials=new Map<string,Record<string,unknown>[]>(),assets=new Map<string,Record<string,unknown>[]>();
   for(const d of registry.rows){for(const[map,key]of [[serials,normalizedIdentifier(d.serialNumber)],[assets,normalizedIdentifier(d.assetNumber)]] as const){if(key)map.set(key,[...(map.get(key)||[]),d]);}}
   const planned:Array<{index:number;deviceId:string|null}>=[];
   for(const index of review.accepted){const row=rows[index],serial=normalizedIdentifier(row.serialNumber),asset=normalizedIdentifier(row.assetNumber);
    const candidates=serial?(serials.get(serial)||((assets.get(asset)||[]).filter(d=>!normalizedIdentifier(d.serialNumber)))):(assets.get(asset)||[]);
    let reason='';const d=candidates[0];
    if(candidates.length>1)reason='Ambiguous asset number — several registered devices match';
    else if(d&&(d.status!=='active'||d.contract_id&&(String(d.added_on)>visit.service_date||d.removed_on&&String(d.removed_on)<visit.service_date)))reason='Device is decommissioned or outside this contract on the service date';
    if(reason)review.warnings.push({row:index+2,identifier:String(row.serialNumber||row.assetNumber||''),reason});else planned.push({index,deviceId:d?String(d.id):null});
   }
   review.warnings.sort((a,b)=>a.row-b.row);
   const definitions:Array<{name:string;source_key:string;kind:string}>=(await db.query('SELECT name,source_key,kind FROM custom_fields WHERE active=true')).rows;
   const keys=new Map(definitions.map(f=>[f.name,f.source_key]));
   const defaults=Object.fromEntries(definitions.filter(f=>f.kind==='checkbox').map(f=>[f.source_key,'No']));
   const options=(await db.query('SELECT name FROM service_status_options')).rows.map(r=>r.name);
   for(const item of planned){const row=rows[item.index],supplied=row.values&&typeof row.values==='object'&&!Array.isArray(row.values)?row.values as Record<string,unknown>:{};const values=Object.fromEntries(Object.entries(supplied).map(([name,value])=>[keys.get(name)||name,value]));if(!options.includes(serviceStatus(values.Serviced)))throw Error('The imported report contains an unknown service status. Add it to Service status options first.');}
   if(body.preview===true){await db.query('COMMIT');return Response.json({accepted:planned.length,skipped:review.warnings.length,warnings:review.warnings});}
   if(!planned.length){await db.query('COMMIT');return Response.json({id:null,imported:0,skipped:review.warnings.length,warnings:review.warnings});}
   const report=(await db.query('INSERT INTO reports(client_name,original_filename,uploaded_by,service_visit_id) VALUES($1,$2,$3,$4) RETURNING id',[visit.client_name,filename,auth.user!.id,visitId])).rows[0];
   for(const uid of userIds)await db.query('INSERT INTO report_assignments(report_id,user_id,assigned_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[report.id,uid,auth.user!.id]);
   for(const item of planned){const row=rows[item.index],serial=String(row.serialNumber||'').trim(),asset=String(row.assetNumber||'').trim();let deviceId=item.deviceId;
    if(!deviceId){const key=serial?'serial:'+normalizedIdentifier(serial):'asset:'+normalizedIdentifier(asset);
     const inserted=await db.query('INSERT INTO devices(client_id,identity_key,device_name,serial_number,lot_number,asset_number) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(client_id,identity_key) DO NOTHING RETURNING id',[visit.client_id,key,String(row.deviceName||'').trim(),serial,String(row.lotNumber||'').trim(),asset]);
     deviceId=inserted.rows[0]?.id;if(!deviceId){const match=await db.query('SELECT id,status FROM devices WHERE client_id=$1 AND identity_key=$2',[visit.client_id,key]);if(match.rows[0]?.status!=='active')throw Error('A device changed while importing. Review the file again.');deviceId=match.rows[0].id;}
    }
    await db.query('INSERT INTO contract_devices(contract_id,device_id,added_on) VALUES($1,$2,$3::date) ON CONFLICT DO NOTHING',[visit.contract_id,deviceId,visit.service_date]);
    const supplied=row.values&&typeof row.values==='object'&&!Array.isArray(row.values)?row.values as Record<string,unknown>:{};
    const values:Record<string,string>={...defaults,...Object.fromEntries(Object.entries(supplied).map(([name,value])=>[keys.get(name)||name,String(value??'')]))};
    values.Serviced=serviceStatus(values.Serviced);if(!options.includes(values.Serviced))throw Error('The imported report contains an unknown service status. Add it to Service status options first.');
    const saved=await db.query('INSERT INTO report_rows(report_id,device_name,serial_number,lot_number,asset_number,hours_in,hours_out,comments,values) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING id',[report.id,String(row.deviceName||''),serial,String(row.lotNumber||''),asset,String(row.hoursIn||''),String(row.hoursOut||''),String(row.comments||''),JSON.stringify(values)]);
    await db.query('INSERT INTO service_visit_devices(service_visit_id,device_id,source_report_row_id,service_status,serviced,comments,values) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[visitId,deviceId,saved.rows[0].id,values.Serviced,values.Serviced==='Serviced',String(row.comments||''),JSON.stringify(values)]);
   }
   await writeAudit(db,auth.user!.id,'uploaded','report',report.id,{clientName:visit.client_name,filename,serviceVisitId:visitId,rowCount:planned.length,skipped:review.warnings.length});
   await db.query('COMMIT');return Response.json({id:report.id,imported:planned.length,skipped:review.warnings.length,warnings:review.warnings},{status:201});
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }catch(error){return errorResponse(error);}
}
