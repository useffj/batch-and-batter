import Image from 'next/image';
export function BrandLogo() {
  return (
    <h1 className="brand-logo">
      <Image
        className="brand-desktop"
        src="/brand/primary-horizontal.png"
        sizes="330px"
        width={1983}
        height={793}
        alt="Batch & Batter Cookie Co."
        priority
      />
      <Image
        className="brand-mobile"
        sizes="160px"
        src="/brand/compact-stacked.png"
        width={1254}
        height={1254}
        alt="Batch & Batter Cookie Co."
        priority
      />
    </h1>
  );
}
export function CookiePhoto({ name }: { name: string }) {
  return (
    <div
      className="cookie-media"
      role="img"
      aria-label={`Photography unavailable for ${name}`}
    >
      <Image
        src="/brand/icon-submark.png"
        sizes="100px"
        width={1254}
        height={1254}
        alt=""
      />
      <small>Photography unavailable</small>
    </div>
  );
}
