import {requireUser} from '../../../lib/auth';
import {getDb} from '../../../lib/db';
import {errorResponse} from '../../../lib/http';
import {secureReportRow} from '../../../lib/report-fields';

export async function GET(request:Request){
 const auth=await requireUser();if(auth.response)return auth.response;
 try{
  const id=new URL(request.url).searchParams.get('row')||'';
  if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))throw Error('Choose a machine activity record.');
  const user=auth.user!,db=await getDb().connect();
  try{
   await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const seedResult=await db.query(`SELECT rr.*,r.client_name,r.original_filename,r.uploaded_at FROM report_rows rr JOIN reports r ON r.id=rr.report_id WHERE rr.id=$1 AND ($2='super_user' OR EXISTS(SELECT 1 FROM report_assignments a WHERE a.report_id=r.id AND a.user_id=$3))`,[id,user.role,user.id]);
   if(!seedResult.rowCount){await db.query('ROLLBACK');return Response.json({error:'Machine record not found.'},{status:404});}
   const seed=seedResult.rows[0];
   const defs=await db.query(`SELECT f.id,f.name,f.kind,f.source_key AS "sourceKey" FROM custom_fields f WHERE f.active=true AND ($2='super_user' OR EXISTS(SELECT 1 FROM user_field_access a WHERE a.field_id=f.id AND a.user_id=$1 AND (a.can_read OR a.can_write))) ORDER BY f.position,f.name`,[user.id,user.role]);
   const allowed=new Set<string>(defs.rows.map((f:{sourceKey:string})=>f.sourceKey));
   const devicesResult=await db.query(`SELECT d.id,d.client_id AS "clientId",c.name AS "clientName",d.device_name AS "deviceName",d.serial_number AS "serialNumber",d.asset_number AS "assetNumber",d.lot_number AS "lotNumber",d.status,d.purchased_on AS "purchasedOn",d.decommissioned_on AS "decommissionedOn",d.decommission_reason AS "decommissionReason",d.notes,d.created_at AS "createdAt",
    EXISTS(SELECT 1 FROM service_visit_devices s WHERE s.device_id=d.id AND s.source_report_row_id=$1) AS "sourceMatch"
    FROM devices d JOIN clients c ON c.id=d.client_id WHERE
    (EXISTS(SELECT 1 FROM service_visit_devices s WHERE s.device_id=d.id AND s.source_report_row_id=$1) OR
     (lower(trim(c.name))=lower(trim($2)) AND (($3<>'' AND lower(trim(d.serial_number))=lower(trim($3))) OR ($3='' AND $4<>'' AND lower(trim(d.asset_number))=lower(trim($4))))))
    AND ($5='super_user' OR EXISTS(SELECT 1 FROM contract_devices cd JOIN contract_assignments ca ON ca.contract_id=cd.contract_id WHERE cd.device_id=d.id AND ca.user_id=$6))`,[id,seed.client_name,seed.serial_number.trim(),seed.asset_number.trim(),user.role,user.id]);
   const direct=devicesResult.rows.filter((d:{sourceMatch:boolean})=>d.sourceMatch),devices=direct.length?direct:devicesResult.rows;
   if(devices.length>1)throw Error('More than one registered device matches this client and identifier. Link this activity record to the correct device before opening its history.');
   const deviceIds=devices.map((d:{id:string})=>d.id);
   const linked=await db.query(`SELECT s.source_report_row_id AS id FROM service_visit_devices s JOIN service_visits v ON v.id=s.service_visit_id WHERE s.device_id=ANY($1::uuid[]) AND s.source_report_row_id IS NOT NULL AND ($2='super_user' OR EXISTS(SELECT 1 FROM contract_assignments a WHERE a.contract_id=v.contract_id AND a.user_id=$3))`,[deviceIds,user.role,user.id]);
   const sourceIds=linked.rows.map((r:{id:string})=>r.id);
   const reports=await db.query(`SELECT rr.id,rr.report_id AS "reportId",rr.device_name AS "deviceName",rr.serial_number AS "serialNumber",rr.asset_number AS "assetNumber",rr.lot_number AS "lotNumber",rr.hours_in AS "hoursIn",rr.hours_out AS "hoursOut",rr.comments,rr.values,r.client_name AS "clientName",r.original_filename AS "fileName",r.uploaded_at AS date
    FROM report_rows rr JOIN reports r ON r.id=rr.report_id WHERE
    (rr.id=$1 OR rr.id=ANY($2::uuid[]) OR (lower(trim(r.client_name))=lower(trim($3)) AND (($4<>'' AND lower(trim(rr.serial_number))=lower(trim($4))) OR ($4='' AND $5<>'' AND lower(trim(rr.asset_number))=lower(trim($5))))))
    AND ($6='super_user' OR EXISTS(SELECT 1 FROM report_assignments a WHERE a.report_id=r.id AND a.user_id=$7))
    ORDER BY r.uploaded_at DESC,rr.created_at DESC`,[id,sourceIds,seed.client_name,seed.serial_number.trim(),seed.asset_number.trim(),user.role,user.id]);
   const reportRows=user.role==='super_user'?reports.rows:reports.rows.map((row:Record<string,unknown>)=>secureReportRow(row,allowed));
   const services=await db.query(`SELECT COALESCE(s.id,v.id) AS id,v.id AS "visitId",cd.device_id AS "deviceId",v.service_date AS date,v.title,v.status,v.location,v.summary,v.recommendations,ct.name AS "contractName",ct.contract_number AS "contractNumber",s.hours_in AS "hoursIn",s.hours_out AS "hoursOut",s.serviced,s.service_status AS "serviceStatus",s.comments,s.values,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'partNumber',p.part_number,'partName',p.part_name,'quantity',p.quantity,'notes',p.notes,'fittedAt',p.fitted_at)) FROM fitted_parts p WHERE p.service_visit_device_id=s.id),'[]') AS parts,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('signerRole',sig.signer_role,'signerName',sig.signer_name,'signedAt',sig.signed_at)) FROM service_visit_signatures sig WHERE sig.service_visit_id=v.id),'[]') AS signatures
    FROM service_visits v JOIN contracts ct ON ct.id=v.contract_id JOIN contract_devices cd ON cd.contract_id=ct.id LEFT JOIN service_visit_devices s ON s.service_visit_id=v.id AND s.device_id=cd.device_id
    WHERE cd.device_id=ANY($1::uuid[]) AND cd.added_on<=v.service_date AND (cd.removed_on IS NULL OR cd.removed_on>=v.service_date) AND ($2='super_user' OR EXISTS(SELECT 1 FROM contract_assignments a WHERE a.contract_id=ct.id AND a.user_id=$3))
    ORDER BY v.service_date DESC`,[deviceIds,user.role,user.id]);
   const clientNames=[...new Set([seed.client_name,...devices.map((d:{clientName:string})=>d.clientName)].map(n=>String(n).trim().toLowerCase()))];
   const serials=[...new Set([seed.serial_number,...devices.map((d:{serialNumber:string})=>d.serialNumber)].map(n=>String(n).trim().toLowerCase()).filter(Boolean))];
   const assets=[...new Set([seed.asset_number,...devices.map((d:{assetNumber:string})=>d.assetNumber)].map(n=>String(n).trim().toLowerCase()).filter(Boolean))];
   const match=`lower(trim(client_name))=ANY($1::text[]) AND ((cardinality($2::text[])>0 AND lower(trim(serial_number))=ANY($2::text[])) OR (cardinality($2::text[])=0 AND cardinality($3::text[])>0 AND lower(trim(asset_number))=ANY($3::text[])))`;
   const repairs=await db.query(`SELECT id,entry_number AS "entryNumber",received_date AS date,completed_date AS "completedDate",device_name AS "deviceName",serial_number AS "serialNumber",asset_number AS "assetNumber",status,priority,reported_fault AS "reportedFault",condition_received AS "conditionReceived",work_carried_out AS "workCarriedOut",parts_used AS "partsUsed",follow_up_work AS "followUpWork",engineer_name AS "engineerName" FROM repair_entries WHERE ${match} AND ($4='super_user' OR created_by=$5 OR engineer_id=$5) ORDER BY received_date DESC`,[clientNames,serials,assets,user.role,user.id]);
   const dockets=await db.query(`SELECT id,'DK-'||entry_number::text AS "entryNumber",signed_at AS date,work_description AS "workDescription",engineer_name AS "engineerName",signer_name AS "signerName",correction_pending AS "correctionPending",started_at AS "startedAt",ended_at AS "endedAt" FROM dockets WHERE lower(trim(client_name))=ANY($1::text[]) AND cardinality($2::text[])>0 AND lower(trim(serial_number))=ANY($2::text[]) AND ($3='super_user' OR created_by=$4) ORDER BY signed_at DESC`,[clientNames,serials,user.role,user.id]);
   const related=[id,...deviceIds,...reports.rows.map((r:{id:string})=>r.id),...services.rows.flatMap((s:{id:string;visitId:string;parts:Array<{id:string}>})=>[s.id,s.visitId,...s.parts.map(p=>p.id)]),...repairs.rows.map((r:{id:string})=>r.id),...dockets.rows.map((d:{id:string})=>d.id)];
   let changes:unknown[]=[],originals:unknown[]=[];
   if(user.role==='super_user'){
    const [audit,versions]=await Promise.all([
     db.query(`SELECT l.id,l.created_at AS date,l.kind,l.entity_type AS "entityType",u.display_name AS actor,l.detail FROM activity_log l LEFT JOIN users u ON u.id=l.actor_id WHERE l.entity_id=ANY($1::uuid[]) ORDER BY l.created_at DESC`,[related]),
     db.query(`SELECT id,entity_id AS "entityId",recorded_at AS date,entity_type AS "entityType",operation,reason FROM admin_entry_history WHERE entity_id=ANY($1::uuid[]) OR (entity_type IN ('repair_entries','dockets') AND lower(trim(snapshot->>'client_name'))=ANY($2::text[]) AND ((cardinality($3::text[])>0 AND lower(trim(snapshot->>'serial_number'))=ANY($3::text[])) OR (cardinality($3::text[])=0 AND cardinality($4::text[])>0 AND lower(trim(snapshot->>'asset_number'))=ANY($4::text[])))) OR (entity_type='service_visits' AND lower(trim(snapshot->'client'->>'name'))=ANY($2::text[]) AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(snapshot->'devices')='array' THEN snapshot->'devices' ELSE '[]'::jsonb END) d WHERE (cardinality($3::text[])>0 AND lower(trim(d->'device'->>'serial_number'))=ANY($3::text[])) OR (cardinality($3::text[])=0 AND cardinality($4::text[])>0 AND lower(trim(d->'device'->>'asset_number'))=ANY($4::text[])))) ORDER BY recorded_at DESC`,[related,clientNames,serials,assets])
    ]);changes=audit.rows;originals=versions.rows;
   }
   await db.query('COMMIT');
   const secured=secureReportRow({deviceName:seed.device_name,serialNumber:seed.serial_number,assetNumber:seed.asset_number,lotNumber:seed.lot_number,values:{}},allowed);
   return Response.json({machine:devices[0]||{...secured,clientName:seed.client_name},fields:defs.rows,reports:reportRows,services:services.rows,repairs:repairs.rows,dockets:dockets.rows,changes,originals,canPrint:user.role==='super_user'||user.canExport,identifierLimited:!seed.serial_number.trim()&&!seed.asset_number.trim()&&!deviceIds.length});
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }catch(error){return errorResponse(error);}
}
