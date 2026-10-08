/**
 * Central configuration, read once from environment variables.
 * Every variable is documented in /.env.example at the repo root.
 */
function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing required environment variable ${name}`);
  return v;
}
const bool = (v: string | undefined, d = false) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(v));
const int = (v: string | undefined, d: number) => (v ? parseInt(v, 10) : d);

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: int(process.env.API_PORT, 3000),
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:8080',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:8080,http://localhost:5173').split(',').map((s) => s.trim()),

  db: {
    url: req('DATABASE_URL', 'postgres://talentscreen:talentscreen@localhost:5432/talentscreen'),
    ssl: bool(process.env.DATABASE_SSL),
    poolMax: int(process.env.DATABASE_POOL_MAX, 10),
  },

  auth: {
    jwtSecret: req('JWT_SECRET', process.env.NODE_ENV === 'production' ? undefined : 'dev-only-change-me-dev-only-change-me'),
    accessTtlSec: int(process.env.JWT_ACCESS_TTL_SECONDS, 900),
    refreshTtlDays: int(process.env.JWT_REFRESH_TTL_DAYS, 7),
    localLoginEnabled: bool(process.env.LOCAL_LOGIN_ENABLED, true),
    maxFailedLogins: int(process.env.MAX_FAILED_LOGINS, 5),
    lockoutMinutes: int(process.env.LOCKOUT_MINUTES, 15),
    oidc: {
      enabled: bool(process.env.OIDC_ENABLED),
      displayName: process.env.OIDC_DISPLAY_NAME ?? 'Microsoft Entra ID',
      issuer: process.env.OIDC_ISSUER ?? '',                 // e.g. https://login.microsoftonline.com/<tenant-id>/v2.0
      clientId: process.env.OIDC_CLIENT_ID ?? '',
      clientSecret: process.env.OIDC_CLIENT_SECRET ?? '',
      redirectUri: process.env.OIDC_REDIRECT_URI ?? 'http://localhost:8080/api/auth/oidc/callback',
      rolesClaim: process.env.OIDC_ROLES_CLAIM ?? 'roles',   // Entra app roles land in "roles"
      autoProvision: bool(process.env.OIDC_AUTO_PROVISION, true),
      defaultRole: process.env.OIDC_DEFAULT_ROLE ?? 'viewer',
    },
  },

  bootstrap: {
    adminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@ecews.local',
    adminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '',
    adminName: process.env.BOOTSTRAP_ADMIN_NAME ?? 'System Administrator',
    organisation: process.env.ORGANISATION_NAME ?? 'Excellence Community Education Welfare Scheme (ECEWS)',
    seedDemo: bool(process.env.SEED_DEMO_DATA),
  },

  /** 32-byte key, base64. Encrypts CV files, CV text and contact details at rest. */
  dataKey: req('DATA_ENCRYPTION_KEY', process.env.NODE_ENV === 'production' ? undefined : 'ZGV2LW9ubHkta2V5LWNoYW5nZS1tZS0zMi1ieXRlcyE='),

  storage: {
    driver: (process.env.STORAGE_DRIVER ?? 'local') as 'local' | 's3' | 'azure',
    localDir: process.env.STORAGE_LOCAL_DIR ?? './data/uploads',
    s3: {
      endpoint: process.env.S3_ENDPOINT,                      // MinIO: http://minio:9000
      region: process.env.S3_REGION ?? 'us-east-1',
      bucket: process.env.S3_BUCKET ?? 'talentscreen-cvs',
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
      forcePathStyle: bool(process.env.S3_FORCE_PATH_STYLE, true),
    },
    azure: {
      connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING ?? '',
      container: process.env.AZURE_STORAGE_CONTAINER ?? 'talentscreen-cvs',
    },
    maxUploadMb: int(process.env.MAX_UPLOAD_MB, 10),
    maxBulkFiles: int(process.env.MAX_BULK_FILES, 50),
  },

  ai: {
    azure: {
      endpoint: process.env.AZURE_OPENAI_ENDPOINT ?? '',
      apiKey: process.env.AZURE_OPENAI_API_KEY ?? '',
      deployment: process.env.AZURE_OPENAI_DEPLOYMENT ?? '',
      apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? '2024-10-21',
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY ?? '',
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      baseUrl: process.env.OPENAI_BASE_URL,
    },
    timeoutMs: int(process.env.AI_TIMEOUT_MS, 60000),
  },

  queue: {
    /** When true the API evaluates CVs in-process (single-container/dev). Production runs the worker service. */
    inline: bool(process.env.EVALUATE_INLINE),
    concurrency: int(process.env.WORKER_CONCURRENCY, 2),
  },

  mail: {
    host: process.env.SMTP_HOST ?? '',
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.SMTP_FROM ?? 'TalentScreen <no-reply@ecews.org>',
  },
};
export type AppConfig = typeof config;
