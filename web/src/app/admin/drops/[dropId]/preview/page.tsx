import { cookies } from 'next/headers';
import { authorize, weeklyDropRelay } from '../../../../../lib/admin/runtime';
import { previewData } from '../../../../../lib/admin/preview';
import { DraftPreview } from '../../../../../components/storefront/draft-preview';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export default async function Page({
  params,
}: {
  params: Promise<{ dropId: string }>;
}) {
  let data;
  try {
    if (process.env.ADMIN_CATALOG_MODE !== 'isolated')
      throw Error('Preview unavailable');
    const cookie = (await cookies()).toString();
    await authorize(cookie, process.env);
    const { dropId } = await params;
    const response = await weeklyDropRelay(
      new Request('https://preview.invalid/', { headers: { cookie } }),
      [dropId, 'preview'],
      process.env,
    );
    if (!response.ok) throw Error('Preview unavailable');
    data = previewData(await response.json(), dropId);
  } catch {
    return (
      <main>
        <h1>Preview unavailable</h1>
        <p>Sign in and save a valid draft before opening its preview.</p>
        <a href="/admin/login">Administrator sign in</a>
      </main>
    );
  }
  return <DraftPreview data={data} />;
}
