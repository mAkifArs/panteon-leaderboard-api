import { config } from 'dotenv'

// Load .env into process.env before any test runs.
// Vitest does not auto-load .env files; without this, tests that
// read DATABASE_URL / REDIS_URL / MONGO_URL would crash unless the
// caller exported them manually.
config({ quiet: true })
