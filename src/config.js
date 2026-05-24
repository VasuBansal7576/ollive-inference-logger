import 'dotenv/config';

export const CONFIG = {
  PORT: process.env.PORT || 3000,
  ENV: process.env.NODE_ENV || 'development',
  
  // Security Tokens
  INGEST_TOKEN: process.env.INGEST_TOKEN || 'ollive_secure_ingest_token_2026',
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || 'ollive_secure_admin_token_2026',
  
  // Rate Limiting
  RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
  RATE_LIMIT_WINDOW_MS: 60000, // 1 minute
  
  // Database
  DB_PATH: process.env.DB_PATH || 'data/ollive.db',
  DB_BUSY_TIMEOUT: parseInt(process.env.DB_BUSY_TIMEOUT || '5000', 10),
  
  // Ingestion Pipeline
  PIPELINE_BATCH_SIZE: parseInt(process.env.PIPELINE_BATCH_SIZE || '20', 10),
  PIPELINE_BATCH_INTERVAL_MS: parseInt(process.env.PIPELINE_BATCH_INTERVAL_MS || '1000', 10),
  
  // Provider API Keys
  GROQ_API_KEY: process.env.GROQ_API_KEY || null,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || null,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || null,
};
