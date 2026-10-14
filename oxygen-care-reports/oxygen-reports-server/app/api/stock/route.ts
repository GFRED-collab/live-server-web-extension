import { requireUser } from '../../../lib/auth';
import { getDb } from '../../../lib/db';

export async function GET() {
  const auth = await requireUser(['super_user', 'warehouse_user', 'engineer']);
  if (auth.response) return auth.response;
  const db = getDb(),
    own = auth.user!.role === 'engineer',
    values = own ? [auth.user!.id] : [];
  const [parts, engineerStock, movements, engineers] = await Promise.all([
    db.query(
      'SELECT id,part_number AS "partNumber",name,location,warehouse_quantity AS "warehouseQuantity" FROM spare_parts ORDER BY part_number'
    ),
    db.query(
      `SELECT s.engineer_id AS "engineerId",s.part_id AS "partId",s.quantity,u.display_name AS "engineerName"
      FROM engineer_stock s JOIN users u ON u.id=s.engineer_id WHERE s.quantity>0 ${own ? 'AND s.engineer_id=$1' : ''} ORDER BY u.display_name`,
      values
    ),
    db.query(
      `SELECT id,movement,quantity,detail,created_at AS "createdAt",part_id AS "partId",engineer_id AS "engineerId"
      FROM stock_movements ${own ? 'WHERE engineer_id=$1' : ''} ORDER BY created_at DESC LIMIT 100`,
      values
    ),
    db.query(
      `SELECT id,display_name AS name FROM users WHERE active=true AND role='engineer' ${own ? 'AND id=$1' : ''} ORDER BY display_name`,
      values
    )
  ]);
  return Response.json({
    parts: parts.rows,
    engineerStock: engineerStock.rows,
    movements: movements.rows,
    engineers: engineers.rows
  });
}
