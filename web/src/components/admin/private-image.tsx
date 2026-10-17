'use client';
import Image from 'next/image';
import { CookiePhoto } from '../storefront/presentation';
import { useState } from 'react';
export function PrivateImage({
  productId,
  mediaId,
  alt,
}: {
  productId: string;
  mediaId: string;
  alt: string;
}) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <CookiePhoto name={alt} />
  ) : (
    <Image
      unoptimized
      width={480}
      height={480}
      style={{
        width: '100%',
        height: 'auto',
        maxHeight: '16rem',
        objectFit: 'contain',
      }}
      src={`/api/admin/products/${encodeURIComponent(productId)}/media/assets/${encodeURIComponent(mediaId)}/image`}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
