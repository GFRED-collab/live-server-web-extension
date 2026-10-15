import { recordSessionActivity } from '../../../../lib/auth';
import { errorResponse } from '../../../../lib/http';
export async function POST() {
  try {
    const remaining = await recordSessionActivity();
    return remaining === null
      ? Response.json({ error: 'Your session has expired. Please sign in again.' }, { status: 401 })
      : Response.json({ sessionRemainingMs: remaining });
  } catch (error) {
    return errorResponse(error);
  }
}
