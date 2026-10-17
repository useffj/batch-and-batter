import { isolatedMediaEnabled } from '../../../../../lib/admin/media-config';
import { mediaRelay } from '../../../../../lib/admin/runtime';
import { mediaResponse } from '../../../../../lib/admin/media-contract';
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
  const images: Record<string, { mediaId: string; alt: string }> = {};
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
    if (isolatedMediaEnabled(process.env))
      for (const product of data.products) {
        const request = new Request('https://preview.invalid/', {
          headers: { cookie },
        });
        const target = { productId: product.id, kind: 'manifest' as const };
        const manifest = await mediaRelay(request, target, process.env);
        if (!manifest.ok) throw Error('Gallery unavailable');
        const result = mediaResponse(await manifest.json(), target);
        if (!result.manifest) throw Error('Invalid gallery');
        const primary = result.manifest.images[0];
        if (primary) {
          const assetTarget = {
            productId: product.id,
            kind: 'asset' as const,
            itemId: primary.mediaId,
          };
          const asset = await mediaRelay(request, assetTarget, process.env);
          if (!asset.ok) throw Error('Image unavailable');
          const ready = mediaResponse(await asset.json(), assetTarget);
          if (ready.asset && ready.asset.state === 'ATTACHED')
            images[product.id] = primary;
        }
      }
  } catch {
    return (
      <main>
        <h1>Preview unavailable</h1>
        <p>Sign in and save a valid draft before opening its preview.</p>
        <a href="/admin/login">Administrator sign in</a>
      </main>
    );
  }
  return <DraftPreview data={data} images={images} />;
}
