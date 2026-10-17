import type { PreviewTransfer } from './gallery-upload';
// Authorization comes only from the validated same-origin relay. Never retain it.
export const transferImage: PreviewTransfer = async (file, a) => {
  const bucket = 'batch-and-batter-dev-isolated-media-302154194958-us-east-2';
  const digest = await crypto.subtle.digest(
    'SHA-256',
    await file.arrayBuffer(),
  );
  const checksum = btoa(String.fromCharCode(...new Uint8Array(digest)));
  if (
    a.url !== `https://${bucket}.s3.us-east-2.amazonaws.com/` ||
    a.fields.bucket !== bucket ||
    !/^staging\/products\/[A-Za-z0-9_-]+\/[a-f0-9]{64}\/source$/.test(
      a.fields.key,
    ) ||
    a.expiresAt <= Date.now() ||
    a.expiresAt > Date.now() + 300000 ||
    file.size < 1 ||
    file.size > 8388608 ||
    a.fields['Content-Type'] !== file.type ||
    a.fields['x-amz-checksum-sha256'] !== checksum
  )
    throw new Error('Upload authorization does not match this image.');
  const form = new FormData();
  for (const [key, value] of Object.entries(a.fields)) form.append(key, value);
  form.append('file', file);
  const r = await fetch(a.url, {
    method: 'POST',
    body: form,
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    signal: AbortSignal.timeout(60000),
  });
  if (r.status !== 204)
    throw new Error('Upload could not be confirmed. Check the same operation.');
};
