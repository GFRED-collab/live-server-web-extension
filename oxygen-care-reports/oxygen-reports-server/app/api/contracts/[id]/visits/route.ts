import { writeAudit } from '../../../../../lib/audit';
import { requireUser } from '../../../../../lib/auth';
import { getDb } from '../../../../../lib/db';
import { errorResponse, jsonObject } from '../../../../../lib/http';
type Context={params:Promise<{id:string}>};

export async function POST(request:Request,context:Context){
  const auth=await requireUser();if(auth.response)return auth.response;
  try{
    const{id}=await context.params,body=await jsonObject(request),serviceDate=String(body.serviceDate||''),title=String(body.title||'Scheduled service').trim();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate))throw Error('A valid service date is required.');
    const db=getDb(),client=await db.connect();
    try{
      await client.query('BEGIN');
      const access=await client.query(`SELECT 1 FROM contracts ct WHERE ct.id=$1 AND ($2='super_user' OR EXISTS(SELECT 1 FROM contract_assignments ca WHERE ca.contract_id=ct.id AND ca.user_id=$3))`,[id,auth.user!.role,auth.user!.id]);
      if(!access.rowCount)return Response.json({error:'Contract not found.'},{status:404});
      const annual=await client.query(`SELECT count(*)::int AS count FROM service_visits WHERE contract_id=$1 AND EXTRACT(YEAR FROM service_date)=EXTRACT(YEAR FROM $2::date)`,[id,serviceDate]);
      const created=await client.query(`INSERT INTO service_visits(contract_id,service_date,title,location,summary,recommendations,created_by) VALUES($1,$2::date,$3,$4,$5,$6,$7) RETURNING id`,[id,serviceDate,title||'Scheduled service',String(body.location||'').trim(),String(body.summary||'').trim(),String(body.recommendations||'').trim(),auth.user!.id]);
      await writeAudit(client,auth.user!.id,'created','service_visit',created.rows[0].id,{contractId:id,serviceDate,title,annualVisitNumber:Number(annual.rows[0].count)+1});
      await client.query('COMMIT');
      return Response.json({id:created.rows[0].id,warning:Number(annual.rows[0].count)>=2?'This is an additional service visit beyond the usual two visits for this contract year.':null},{status:201});
    }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  }catch(error){return errorResponse(error)}
}
