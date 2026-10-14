import { currentUser } from '../../../../lib/auth';

export async function GET() {
  const user = await currentUser();
  return user
    ? Response.json({ user })
    : Response.json({ error: 'Authentication required.' }, { status: 401 });
}
