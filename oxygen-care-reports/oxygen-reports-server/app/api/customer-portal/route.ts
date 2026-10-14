import {requireUser} from '../../../lib/auth';
import {getDb} from '../../../lib/db';
import {errorResponse} from '../../../lib/http';

export async function GET(){
 const auth=await requireUser(['customer']);if(auth.response)return auth.response;
 const db=await getDb().connect();
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  // No caller-supplied client IDs: every dataset derives tenancy from the account.
  const client=await db.query(`SELECT c.id,c.name,c.contact_name AS "contactName",c.email,c.phone,c.address
   FROM clients c JOIN users u ON u.client_id=c.id WHERE u.id=$1 AND u.role='customer' AND u.active=true`,[auth.user!.id]);
  if(!client.rowCount){await db.query('ROLLBACK');return Response.json({error:'Customer access is not configured.'},{status:403});}
  const contracts=await db.query(`SELECT ct.id,ct.name,ct.contract_number AS "contractNumber",ct.status,ct.start_date::text AS "startDate",ct.end_date::text AS "endDate"
   FROM contracts ct JOIN users u ON u.client_id=ct.client_id WHERE u.id=$1 AND u.role='customer' AND u.active=true ORDER BY ct.name,ct.id LIMIT 1001`,[auth.user!.id]);
  const devices=await db.query(`SELECT d.id,cd.contract_id AS "contractId",d.device_name AS "deviceName",d.serial_number AS "serialNumber",d.asset_number AS "assetNumber",d.lot_number AS "lotNumber",d.status,cd.removed_on::text AS "removedOn"
   FROM devices d JOIN contract_devices cd ON cd.device_id=d.id JOIN contracts ct ON ct.id=cd.contract_id AND ct.client_id=d.client_id
   JOIN users u ON u.client_id=ct.client_id WHERE u.id=$1 AND u.role='customer' AND u.active=true ORDER BY d.device_name,d.serial_number,d.id LIMIT 10001`,[auth.user!.id]);
  const services=await db.query(`SELECT sd.id,sd.device_id AS "deviceId",v.id AS "visitId",v.contract_id AS "contractId",v.service_date::text AS date,v.title,v.location,sd.service_status AS "serviceStatus",
   COALESCE((SELECT jsonb_agg(jsonb_build_object('partNumber',p.part_number,'partName',p.part_name,'quantity',p.quantity,'fittedAt',p.fitted_at) ORDER BY p.fitted_at,p.id) FROM fitted_parts p WHERE p.service_visit_device_id=sd.id),'[]') AS parts,
   (SELECT jsonb_agg(jsonb_build_object('role',s.signer_role,'name',s.signer_name,'signedAt',s.signed_at) ORDER BY s.signer_role) FROM service_visit_signatures s WHERE s.service_visit_id=v.id) AS signatures
   FROM service_visit_devices sd JOIN service_visits v ON v.id=sd.service_visit_id JOIN contracts ct ON ct.id=v.contract_id
   JOIN devices d ON d.id=sd.device_id AND d.client_id=ct.client_id JOIN users u ON u.client_id=ct.client_id
   WHERE u.id=$1 AND u.role='customer' AND u.active=true AND v.status='finalized'
   AND EXISTS(SELECT 1 FROM service_visit_signatures s WHERE s.service_visit_id=v.id AND s.signer_role='engineer')
   AND EXISTS(SELECT 1 FROM service_visit_signatures s WHERE s.service_visit_id=v.id AND s.signer_role='client')
   ORDER BY v.service_date DESC,v.id,sd.id LIMIT 10001`,[auth.user!.id]);
  if(contracts.rows.length>1000||devices.rows.length>10000||services.rows.length>10000)throw Error('Your portal exceeds the current record limit. Please contact Oxygen Care for an export.');
  await db.query('COMMIT');
  return Response.json({client:client.rows[0],contracts:contracts.rows,devices:devices.rows,services:services.rows,canExport:auth.user!.canExport});
 }catch(error){await db.query('ROLLBACK');return errorResponse(error);}finally{db.release();}
}
