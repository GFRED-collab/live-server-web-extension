import {requireUser} from '../../../../lib/auth';
import {getDb} from '../../../../lib/db';
import {errorResponse} from '../../../../lib/http';
export async function GET(request:Request){
 const auth=await requireUser();if(auth.response)return auth.response;
 try{
  const url=new URL(request.url),kind=url.searchParams.get('kind'),search=(url.searchParams.get('q')||'').trim().slice(0,160),client=url.searchParams.get('client')||'';
  if(!['clients','devices'].includes(kind||''))throw Error('Choose clients or devices.');
  if(client&&!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(client))throw Error('Choose a valid client.');
  const params=[auth.user!.role,auth.user!.id,'%'+search+'%',client||null];
  const scope=`($1='super_user' OR EXISTS(SELECT 1 FROM contracts ct JOIN contract_assignments ca ON ca.contract_id=ct.id WHERE ct.client_id=c.id AND ca.user_id=$2))`;
  const result=kind==='clients'?await getDb().query(`SELECT c.id,c.name AS "clientName",c.address,c.contact_name AS "contactName" FROM clients c WHERE ${scope} AND concat_ws(' ',c.name,c.address,c.contact_name) ILIKE $3 AND ($4::uuid IS NULL OR c.id=$4::uuid) ORDER BY c.name,c.id LIMIT 51`,params):await getDb().query(`SELECT d.id,d.client_id AS "clientId",c.name AS "clientName",c.address,c.contact_name AS "contactName",d.device_name AS "deviceName",d.serial_number AS "serialNumber",d.asset_number AS "assetNumber" FROM devices d JOIN clients c ON c.id=d.client_id WHERE d.status='active' AND ($1='super_user' OR EXISTS(SELECT 1 FROM contract_devices cd JOIN contract_assignments ca ON ca.contract_id=cd.contract_id WHERE cd.device_id=d.id AND ca.user_id=$2 AND cd.removed_on IS NULL)) AND ($4::uuid IS NULL OR c.id=$4::uuid) AND concat_ws(' ',c.name,d.device_name,d.serial_number,d.asset_number) ILIKE $3 ORDER BY c.name,d.device_name,d.serial_number,d.id LIMIT 51`,params);
  return Response.json({items:result.rows.slice(0,50),hasMore:result.rows.length>50});
 }catch(error){return errorResponse(error);}
}
