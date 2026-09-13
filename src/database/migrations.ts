import type { Knex } from 'knex';
import { getEncryptionService } from './encryption';
import { decryptJsonField, parseStoredJson, validateContextJson } from './utils';

export const SCHEMA_VERSION = 2;
const MIGRATIONS_TABLE = '_astreus_schema_migrations';
const CONTEXT_JSON_ENVELOPE_VERSION = 2;

/**
 * SQLite previously accepted bare ciphertext in its JSON column. PostgreSQL rejected it.
 * Authenticate and wrap those rows once, without changing ciphertext, summaries or timestamps.
 * The write lock, updates and durable marker share one transaction: failures leave no partial migration.
 */
export async function migrateContextJsonEnvelope(database: Knex): Promise<void> {
  if (database.client.dialect !== 'sqlite3') return;
  for (let attempt = 0; ; attempt++) {
    try {
      await migrateContextJsonEnvelopeTransaction(database);
      return;
    } catch (error) {
      // A concurrent SQLite schema read can lose the race to upgrade its transaction
      // to a write lock. Retry the whole rolled-back transaction, never individual rows.
      if (
        attempt >= 2 ||
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        error.code !== 'SQLITE_BUSY'
      )
        throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

async function migrateContextJsonEnvelopeTransaction(database: Knex): Promise<void> {
  // Keep ownership until cleanup finishes: Knex releases its own connection even when
  // SQLite COMMIT fails with SQLITE_BUSY and leaves the native transaction active.
  const connection: unknown = await database.client.acquireConnection();
  try {
    await database.transaction(applyContextJsonEnvelopeMigration, { connection });
  } catch (error) {
    try {
      await database.raw('ROLLBACK').connection(connection);
    } catch (rollbackError) {
      // Callback failures may already have been rolled back by Knex. This is the only
      // benign rollback failure; otherwise prevent the pool from reusing the connection.
      if (
        !(
          rollbackError instanceof Error &&
          rollbackError.message.includes('no transaction is active')
        )
      ) {
        if (connection && typeof connection === 'object') {
          Object.assign(connection, { __knex__disposed: 'SQLite migration rollback failed' });
        }
        throw new Error('SQLite migration rollback failed; connection marked unusable');
      }
    }
    throw error;
  } finally {
    await database.client.releaseConnection(connection);
  }
}

async function applyContextJsonEnvelopeMigration(trx: Knex.Transaction): Promise<void> {
  await trx.raw(
    'CREATE TABLE IF NOT EXISTS ?? (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
    [MIGRATIONS_TABLE]
  );
  // INSERT acquires the write lock even when the ledger already exists. The marker
  // becomes durable only when every row below succeeds and the transaction commits.
  const inserted = await trx(MIGRATIONS_TABLE)
    .insert({ version: CONTEXT_JSON_ENVELOPE_VERSION, applied_at: new Date().toISOString() })
    .onConflict('version')
    .ignore()
    .returning('version');
  if (inserted.length === 0) return;

  const encryption = getEncryptionService();
  let afterId: string | undefined;
  for (;;) {
    const query = trx<{ id: string; contextData: string | null }>('contexts')
      .select('id', 'contextData')
      .orderBy('id')
      .limit(100);
    if (afterId !== undefined) query.where('id', '>', afterId);
    const rows = await query;
    if (rows.length === 0) break;

    for (const row of rows) {
      if (row.contextData === null) continue;
      try {
        if (encryption.isEncrypted(row.contextData)) {
          const plaintext = await encryption.decrypt(row.contextData, 'contexts.contextData');
          validateContextJson(parseStoredJson(plaintext, 'contexts.contextData'));
          await trx('contexts')
            .where({ id: row.id })
            .update({ contextData: JSON.stringify({ _encrypted: row.contextData }) });
        } else {
          // Reject corruption before marking the transition complete. Plaintext arrays stay plaintext.
          await decryptJsonField(row.contextData, 'contexts.contextData');
        }
      } catch {
        throw new Error(
          `Context JSON migration failed for row ${row.id}; verify its data and encryption key before retrying`
        );
      }
    }
    afterId = rows[rows.length - 1].id;
  }
}
