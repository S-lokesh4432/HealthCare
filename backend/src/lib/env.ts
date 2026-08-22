import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

function optional(name: string): string | null {
  const value = process.env[name];
  return value && value.trim() !== '' ? value : null;
}

export const env = {
  databaseUrl: required('DATABASE_URL'),
  port: Number(process.env.PORT) || 4000,
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  appBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:4000',

  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '24h',

  geminiApiKey: optional('GEMINI_API_KEY'),
  xaiApiKey: optional('XAI_API_KEY'),

  resendApiKey: optional('RESEND_API_KEY'),
  emailFrom: optional('EMAIL_FROM'),

  googleClientId: optional('GOOGLE_CLIENT_ID'),
  googleClientSecret: optional('GOOGLE_CLIENT_SECRET'),
  googleRedirectUri: optional('GOOGLE_REDIRECT_URI'),

  cronSecret: optional('CRON_SECRET'),
  encryptionKey: optional('ENCRYPTION_KEY'),
};

export const featureStatus = {
  llm: Boolean(env.geminiApiKey || env.xaiApiKey),
  email: Boolean(env.resendApiKey && env.emailFrom),
  calendar: Boolean(
    env.googleClientId && env.googleClientSecret && env.googleRedirectUri && env.encryptionKey
  ),
  cron: Boolean(env.cronSecret),
};
