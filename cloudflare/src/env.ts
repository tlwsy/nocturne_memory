export type AppEnv = Env & {
  API_TOKEN?: string;
  ENVIRONMENT?: string;
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  ASSETS?: Fetcher;
};

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ApiResult<T = unknown> = T | { error: string; detail?: string };
