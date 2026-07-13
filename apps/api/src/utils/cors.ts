const isProduction = process.env.NODE_ENV === "production";

const DEFAULT_DEV_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:3003",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
  "http://127.0.0.1:3002",
  "http://127.0.0.1:3003",
];

export function getAllowedOrigins(): string[] {
  const configuredOrigins = process.env.WEB_ALLOWED_ORIGINS ?? process.env.WEB_PUBLIC_API_URL;
  const devOrigins = isProduction ? [] : DEFAULT_DEV_ORIGINS;

  if (configuredOrigins) {
    const origins = configuredOrigins
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);

    return Array.from(new Set([...origins, ...devOrigins]));
  }

  return devOrigins;
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return true;
  }

  return getAllowedOrigins().includes(origin);
}
