import profile from './shared-profile.json';
type ProfileConfig = Partial<
  Record<keyof typeof profile | 'STOREFRONT_API_BASE_URL', string>
>;
export function sharedWorkspace(c: ProfileConfig | NodeJS.ProcessEnv) {
  return (
    Object.entries(profile).every(
      ([key, value]) => c[key as keyof typeof profile] === value,
    ) &&
    ['https://storefront.invalid', 'https://storefront.invalid/'].includes(
      c.STOREFRONT_API_BASE_URL ?? '',
    )
  );
}
export function isolatedMediaEnabled(c: ProfileConfig | NodeJS.ProcessEnv) {
  if (sharedWorkspace(c)) return true;
  return (
    c.ADMIN_MEDIA_MODE === 'isolated' &&
    c.ADMIN_CATALOG_MODE === 'isolated' &&
    c.ADMIN_API_BASE_URL ===
      'https://ui8k11k343.execute-api.us-east-2.amazonaws.com' &&
    c.ADMIN_ORIGIN === 'https://admin-dev-3b23b18.d1aw7cfglvejmo.amplifyapp.com'
  );
}
