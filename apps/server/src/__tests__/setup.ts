import path from 'node:path';
import * as dotenv from 'dotenv';

import { REPO_ROOT } from '../paths';

// Load the real .env first so integration tests talk to the developer's actual
// database, then fill in defaults for anything it did not define — the suite
// stays runnable without a .env and without a database (those tests skip).
dotenv.config({ path: path.join(REPO_ROOT, '.env') });

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/streaming_backbone';
process.env.JWT_SECRET ??= '0'.repeat(64);
process.env.LOG_LEVEL ??= 'silent';
