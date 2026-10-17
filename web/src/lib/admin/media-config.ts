export function isolatedMediaEnabled(
  c:
    | NodeJS.ProcessEnv
    | {
        ADMIN_MEDIA_MODE?: string;
        ADMIN_CATALOG_MODE?: string;
        ADMIN_API_BASE_URL?: string;
        ADMIN_ORIGIN?: string;
      },
) {
  return (
    c.ADMIN_MEDIA_MODE === 'isolated' &&
    c.ADMIN_CATALOG_MODE === 'isolated' &&
    c.ADMIN_API_BASE_URL ===
      'https://ui8k11k343.execute-api.us-east-2.amazonaws.com' &&
    c.ADMIN_ORIGIN === 'https://admin-dev-3b23b18.d1aw7cfglvejmo.amplifyapp.com'
  );
}
