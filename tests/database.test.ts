import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import knex, { type Knex } from 'knex';
import { Database, getDatabase, initializeDatabase, SCHEMA_VERSION } from '../src/database';
import { createKnexConfig, getPoolManager } from '../src/database/knex';
import { migrateContextJsonEnvelope } from '../src/database/migrations';
import { getEncryptionService, resetEncryptionService } from '../src/database/encryption';
import { decryptSensitiveFields, encryptSensitiveFields } from '../src/database/utils';
import { ContextStorage } from '../src/context/storage';
import { Logger, initializeLoggerSync } from '../src/logger';
import type { DatabaseConfig } from '../src/database/types';
import type { ContextMessage } from '../src/context/types';
import { GraphStorage } from '../src/graph/storage';
import type { Graph } from '../src/graph/types';

const execute = promisify(execFile);
const databases = new Set<Database>();
const pools = new Set<Knex>();
const logger = new Logger({ level: 'silent', enableConsole: false });
const originalEnvironment = {
  ENCRYPTION_ENABLED: process.env.ENCRYPTION_ENABLED,
  ENCRYPTION_MASTER_KEY: process.env.ENCRYPTION_MASTER_KEY,
  DB_URL: process.env.DB_URL,
};
let directory: string;
let postgresBin: string;
let postgresStarted = false;
let postgresUrl: string;

function configureEncryption(enabled: boolean): void {
  process.env.ENCRYPTION_ENABLED = String(enabled);
  process.env.ENCRYPTION_MASTER_KEY = randomBytes(32).toString('base64');
  resetEncryptionService();
}

async function findPostgres(): Promise<string> {
  const candidates = [
    process.env.ASTREUS_TEST_PG_BIN,
    '/opt/homebrew/opt/postgresql@17/bin',
    '/usr/lib/postgresql/17/bin',
    '/usr/local/opt/postgresql@17/bin',
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(join(candidate, 'initdb'));
      return candidate;
    } catch {
      continue;
    }
  }
  const { stdout } = await execute('pg_config', ['--bindir'], { timeout: 5000 });
  return stdout.trim();
}

before(async () => {
  initializeLoggerSync({ level: 'silent', enableConsole: false });
  directory = await mkdtemp(join(tmpdir(), 'astreus-database-test-'));
  postgresBin = await findPostgres();
  const socket = join(directory, 'socket');
  await mkdir(socket, { mode: 0o700 });
  await execute(
    join(postgresBin, 'initdb'),
    ['-D', join(directory, 'pg'), '-A', 'trust', '-U', 'postgres', '--no-locale', '-E', 'UTF8'],
    { timeout: 30000 }
  );
  // A private Unix socket only: never connect to an existing or network database.
  await execute(
    join(postgresBin, 'pg_ctl'),
    [
      '-D',
      join(directory, 'pg'),
      '-l',
      join(directory, 'postgres.log'),
      '-o',
      `-h '' -k '${socket}' -F`,
      '-w',
      '-t',
      '15',
      'start',
    ],
    { timeout: 20000 }
  );
  postgresStarted = true;
  postgresUrl = `postgresql://postgres@localhost/postgres?host=${encodeURIComponent(socket)}`;
});

after(async () => {
  try {
    await Promise.all([...databases].map((database) => database.disconnect()));
    await Promise.all([...pools].map((pool) => pool.destroy()));
  } finally {
    if (postgresStarted) {
      await execute(
        join(postgresBin, 'pg_ctl'),
        ['-D', join(directory, 'pg'), '-m', 'immediate', '-w', '-t', '15', 'stop'],
        { timeout: 20000 }
      );
    }
    if (directory) await rm(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEncryptionService();
    logger.dispose();
  }
});

async function createDatabase(type: 'sqlite' | 'postgres'): Promise<Database> {
  const config: DatabaseConfig =
    type === 'postgres'
      ? { type, connectionString: postgresUrl, minPoolSize: 0, maxPoolSize: 3 }
      : { connectionString: `sqlite://${join(directory, `${randomUUID()}.sqlite`)}` };
  const database = new Database(config, logger);
  databases.add(database);
  await database.connect();
  await database.initialize();
  return database;
}

async function addAgent(database: Knex): Promise<string> {
  const id = randomUUID();
  await database('agents').insert({ id, name: id });
  return id;
}

function decodeStored(value: unknown): unknown {
  return typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
}

function ciphertext(value: unknown): string {
  const parsed = decodeStored(value);
  assert.ok(parsed && typeof parsed === 'object' && '_encrypted' in parsed);
  assert.equal(Object.keys(parsed).length, 1);
  assert.equal(typeof parsed._encrypted, 'string');
  return parsed._encrypted as string;
}

function corruptCipher(value: string): string {
  const parts = value.split(':');
  const encrypted = Buffer.from(parts[3], 'base64');
  encrypted[0] ^= 1;
  parts[3] = encrypted.toString('base64');
  return parts.join(':');
}

for (const type of ['sqlite', 'postgres'] as const) {
  for (const encrypted of [false, true]) {
    test(`${type}: create/read/update preserves opaque messages and summary, encryption=${encrypted}`, async () => {
      configureEncryption(encrypted);
      const database = await createDatabase(type);
      const sql = database.getKnex();
      const storage = new ContextStorage(sql, logger);
      const agentId = await addAgent(sql);
      // Extra fields deliberately survive without projecting a provider's message shape.
      const messages = [
        {
          role: 'assistant' as const,
          content: `message-${randomUUID()}`,
          opaque: {
            blocks: [{ type: 'reasoning', payload: randomUUID() }],
            flags: [false, null, 0],
          },
          providerData: {
            protocol: 'openai-responses',
            model: 'gpt-6-astra',
            output: [
              {
                type: 'reasoning',
                id: randomUUID(),
                encrypted_content: randomBytes(16).toString('base64'),
                summary: [{ type: 'summary_text', text: 'provider summary' }],
              },
            ],
          },
          tool_calls: [
            { id: randomUUID(), type: 'function', function: { name: 'lookup', arguments: {} } },
          ],
        },
        {
          role: 'assistant',
          content: 'text after thinking',
          providerData: {
            protocol: 'claude-messages',
            model: 'claude-sonnet-5',
            content: [
              {
                type: 'thinking',
                thinking: 'preserve this block',
                signature: randomBytes(16).toString('base64'),
              },
              { type: 'redacted_thinking', data: randomBytes(16).toString('base64') },
              { type: 'text', text: 'text after thinking', citations: null },
            ],
          },
        },
        {
          role: 'assistant',
          content: 'gateway response',
          providerData: {
            protocol: 'openai-chat-completions',
            model: 'openrouter/free',
            message: {
              role: 'assistant',
              content: 'gateway response',
              refusal: null,
              reasoning_details: [
                { type: 'reasoning.encrypted', data: randomBytes(16).toString('base64') },
              ],
            },
          },
        },
        { role: 'tool', content: 'tool result', tool_call_id: randomUUID() },
        {
          role: 'user',
          content: 'inspect this image',
          inputContent: [
            { type: 'text', text: 'inspect this image' },
            {
              type: 'image_url',
              image_url: { url: 'https://example.com/image.png', detail: 'high' },
            },
          ],
        },
      ] satisfies (ContextMessage & { opaque?: Record<string, unknown> })[];
      const contextData: ContextMessage[] = messages;
      const summary = `enc:plain explanation ${randomUUID()}`;
      const saved = await storage.saveContext({ agentId, contextData, summary, tokensUsed: 12 });
      assert.deepEqual(saved.contextData, messages);
      assert.equal(saved.summary, summary);
      assert.deepEqual((await storage.loadContext(agentId))?.contextData, messages);
      const raw = await sql('contexts').where({ agentId }).first();
      if (encrypted) {
        assert.ok(ciphertext(raw.contextData).startsWith('enc:1:'));
        assert.ok(String(raw.summary).startsWith('enc:1:'));
        assert.equal(JSON.stringify(raw.contextData).includes(messages[0].content), false);
        assert.equal(String(raw.summary).includes(summary), false);
      } else {
        assert.deepEqual(decodeStored(raw.contextData), messages);
        assert.equal(raw.summary, summary);
      }
      const updated = await storage.saveContext({
        agentId,
        contextData: [...contextData, { role: 'user', content: 'next' }],
        summary: 'updated',
      });
      assert.equal(updated.id, saved.id);
      assert.equal(updated.contextData.length, messages.length + 1);
      assert.deepEqual(updated.contextData[0], messages[0]);
      await storage.updateContextMetadata(agentId, { summary: 'compressed', tokensUsed: 5 });
      const loaded = await storage.loadContext(agentId);
      assert.equal(loaded?.summary, 'compressed');
      assert.equal(loaded?.tokensUsed, 5);
      assert.deepEqual(loaded?.contextData, updated.contextData);
      const metadata = { nested: { items: [0, false, null] }, value: randomUUID() };
      const encoded = await encryptSensitiveFields({ metadata: JSON.stringify(metadata) }, 'tasks');
      const decoded = await decryptSensitiveFields(
        { metadata: decodeStored(encoded.metadata) },
        'tasks'
      );
      assert.deepEqual(decodeStored(decoded.metadata), metadata);
      if (type === 'postgres') {
        const result = await sql.raw('SELECT inet_server_addr() AS address');
        assert.equal(result.rows[0].address, null);
      }
      await database.disconnect();
    });

    test(`${type}: empty and null contexts remain distinct in storage, encryption=${encrypted}`, async () => {
      configureEncryption(encrypted);
      const database = await createDatabase(type);
      const sql = database.getKnex();
      const storage = new ContextStorage(sql, logger);
      const agentId = await addAgent(sql);
      assert.equal(await storage.loadContext(agentId), null);
      const empty = await storage.saveContext({ agentId, contextData: [], summary: '' });
      assert.deepEqual(empty.contextData, []);
      assert.equal(empty.summary, '');
      let raw = await sql('contexts').where({ agentId }).first();
      if (encrypted) assert.ok(ciphertext(raw.contextData));
      else assert.deepEqual(decodeStored(raw.contextData), []);
      const absent = await storage.saveContext({ agentId });
      assert.deepEqual(absent.contextData, []);
      raw = await sql('contexts').where({ agentId }).first();
      assert.equal(raw.contextData, null);
      await sql('contexts').where({ agentId }).update({ contextData: 'null' });
      assert.deepEqual((await storage.loadContext(agentId))?.contextData, []);
      await database.disconnect();
    });
  }

  test(`${type}: tampering, wrong key, field substitution and malformed envelopes fail explicitly`, async () => {
    configureEncryption(true);
    const database = await createDatabase(type);
    const sql = database.getKnex();
    const storage = new ContextStorage(sql, logger);
    const agentId = await addAgent(sql);
    await storage.saveContext({
      agentId,
      contextData: [{ role: 'user', content: 'private context' }],
      summary: 'private summary',
    });
    const original = await sql('contexts').where({ agentId }).first();
    const cipher = ciphertext(original.contextData);
    const replace = (value: unknown) =>
      sql('contexts')
        .where({ agentId })
        .update({ contextData: JSON.stringify(value) });
    for (const invalid of [
      { _encrypted: corruptCipher(cipher) },
      { _encrypted: original.summary },
      { _encrypted: null },
      { _encrypted: 7 },
      { _encrypted: 'not encrypted' },
      { _encrypted: 'enc:broken' },
      { _encrypted: cipher, extra: true },
      { _encrypted: cipher.replace('enc:1:', 'enc:2:') },
      { unexpected: [] },
      [null],
      [{}],
      [{ role: 'user', content: null }],
      false,
      0,
      '',
    ]) {
      await replace(invalid);
      await assert.rejects(storage.loadContext(agentId));
    }
    const invalidPlaintext = await getEncryptionService().encrypt(
      '{invalid json',
      'contexts.contextData'
    );
    await replace({ _encrypted: invalidPlaintext });
    await assert.rejects(storage.loadContext(agentId), /Invalid JSON/);
    await replace({ _encrypted: cipher });
    await sql('contexts')
      .where({ agentId })
      .update({ summary: corruptCipher(original.summary) });
    await assert.rejects(storage.loadContext(agentId), /summary/);
    await sql('contexts').where({ agentId }).update({ summary: 'enc:broken' });
    await assert.rejects(storage.loadContext(agentId), /summary/);
    await sql('contexts').where({ agentId }).update({ summary: original.summary });
    configureEncryption(true);
    await assert.rejects(storage.loadContext(agentId), /decrypt/);
    configureEncryption(false);
    await assert.rejects(storage.loadContext(agentId), /enabled/);
    await database.disconnect();
  });
}

test('SQLite: explicit migration is transactional, authenticated, durable and idempotent', async () => {
  configureEncryption(true);
  const database = await createDatabase('sqlite');
  const sql = database.getKnex();
  const storage = new ContextStorage(sql, logger);
  const agentId = await addAgent(sql);
  await storage.saveContext({
    agentId,
    contextData: [{ role: 'user', content: 'migrate me' }],
    summary: 'keep summary',
  });
  const row = await sql('contexts').where({ agentId }).first();
  const bareCipher = ciphertext(row.contextData);
  await sql('contexts').where({ agentId }).update({ contextData: bareCipher });
  // A read never implicitly falls back to the old format.
  await assert.rejects(storage.loadContext(agentId), /Invalid JSON/);
  await sql('_astreus_schema_migrations').delete();
  const invalidAgent = await addAgent(sql);
  await sql('contexts').insert({
    id: 'zz-invalid',
    agentId: invalidAgent,
    contextData: 'enc:broken',
  });
  await assert.rejects(migrateContextJsonEnvelope(sql), /migration failed/);
  assert.equal((await sql('contexts').where({ agentId }).first()).contextData, bareCipher);
  assert.equal((await sql('_astreus_schema_migrations')).length, 0);
  await sql('contexts').where({ agentId: invalidAgent }).update({ contextData: '[]' });
  const key = process.env.ENCRYPTION_MASTER_KEY;
  configureEncryption(true);
  await assert.rejects(migrateContextJsonEnvelope(sql), /migration failed/);
  assert.equal((await sql('contexts').where({ agentId }).first()).contextData, bareCipher);
  assert.equal((await sql('_astreus_schema_migrations')).length, 0);
  process.env.ENCRYPTION_MASTER_KEY = key;
  resetEncryptionService();
  const concurrent = knex(sql.client.config);
  pools.add(concurrent);
  await Promise.all([migrateContextJsonEnvelope(sql), migrateContextJsonEnvelope(concurrent)]);
  await concurrent.destroy();
  await database.initialize();
  const migrated = await sql('contexts').where({ agentId }).first();
  assert.equal(ciphertext(migrated.contextData), bareCipher);
  assert.equal(migrated.summary, row.summary);
  assert.equal(migrated.updated_at, row.updated_at);
  assert.equal((await sql('contexts').where({ agentId: invalidAgent }).first()).contextData, '[]');
  assert.deepEqual((await storage.loadContext(agentId))?.contextData, [
    { role: 'user', content: 'migrate me' },
  ]);
  assert.equal((await storage.loadContext(agentId))?.summary, 'keep summary');
  const versions = await sql('_astreus_schema_migrations');
  assert.equal(versions.length, 1);
  assert.equal(versions[0].version, SCHEMA_VERSION);
  await database.initialize();
  assert.deepEqual(await sql('_astreus_schema_migrations'), versions);
  assert.deepEqual(await sql('contexts').where({ agentId }).first(), migrated);
  await database.disconnect();
  await database.connect();
  await database.initialize();
  assert.deepEqual(await sql('_astreus_schema_migrations'), versions);
  await database.disconnect();
});

test('SQLite: COMMIT contention rolls back before returning a connection or retrying migration', async (t) => {
  configureEncryption(true);
  const database = await createDatabase('sqlite');
  const sql = database.getKnex();
  const agentId = await addAgent(sql);
  const cipher = await getEncryptionService().encrypt(
    JSON.stringify([{ role: 'user', content: 'commit contention' }]),
    'contexts.contextData'
  );
  await sql('contexts').insert({ id: randomUUID(), agentId, contextData: cipher });
  await sql('_astreus_schema_migrations').delete();
  await sql.raw('PRAGMA busy_timeout = 20');
  const reader = knex(sql.client.config);
  pools.add(reader);
  const readTransaction = await reader.transaction();
  t.after(async () => {
    await readTransaction.rollback();
  });
  await readTransaction('contexts').select('id');
  let commitFailures = 0;
  const onQueryError = (_error: unknown, query: { sql: string }): void => {
    if (query.sql === 'COMMIT;') commitFailures++;
  };
  sql.on('query-error', onQueryError);
  t.after(() => {
    sql.removeListener('query-error', onQueryError);
  });
  await assert.rejects(migrateContextJsonEnvelope(sql), (error: unknown) => {
    assert.ok(error && typeof error === 'object' && 'code' in error);
    assert.equal(error.code, 'SQLITE_BUSY');
    return true;
  });
  assert.equal(commitFailures, 3);
  await readTransaction.rollback();
  await reader.destroy();
  // A fresh transaction must work on the same pool after exhausted COMMIT retries.
  await sql.transaction(async (trx) => {
    assert.equal((await trx('_astreus_schema_migrations')).length, 0);
    assert.equal((await trx('contexts').where({ agentId }).first()).contextData, cipher);
  });
  await migrateContextJsonEnvelope(sql);
  assert.equal((await sql('_astreus_schema_migrations')).length, 1);
  assert.equal(ciphertext((await sql('contexts').where({ agentId }).first()).contextData), cipher);
  await database.disconnect();
});

function createPool(max: number = 2, connectionString: string = postgresUrl): Knex {
  const config = createKnexConfig({
    type: 'postgres',
    connectionString,
    minPoolSize: 0,
    maxPoolSize: max,
  });
  config.pool = {
    ...config.pool,
    acquireTimeoutMillis: 60,
    createTimeoutMillis: 200,
    idleTimeoutMillis: 30,
  };
  const database = knex(config);
  pools.add(database);
  return database;
}

test('Tarn: tracks actual reuse, out-of-order release, held versus idle, and per-pool lifecycle', async (t) => {
  const first = createPool();
  const second = createPool(1);
  const monitor = getPoolManager(first, 20, logger);
  const secondMonitor = getPoolManager(second, 20, logger);
  assert.notEqual(monitor, secondMonitor);
  const pool = first.client.pool;
  assert.ok(pool);
  const a: unknown = await pool.acquire().promise;
  t.after(() => {
    pool.release(a);
  });
  const b: unknown = await pool.acquire().promise;
  t.after(() => {
    pool.release(b);
  });
  assert.equal(monitor.getStats().activeConnections, 2);
  assert.equal(secondMonitor.getStats().activeConnections, 0);
  assert.equal(pool.release({}), false);
  assert.equal(monitor.getStats().activeConnections, 2);
  pool.release(b);
  assert.equal(monitor.getStats().activeConnections, 1);
  const reused: unknown = await pool.acquire().promise;
  t.after(() => {
    pool.release(reused);
  });
  assert.equal(reused, b);
  await delay(35);
  assert.equal(monitor.detectLeaks().length, 2);
  pool.release(a);
  assert.equal(monitor.detectLeaks().length, 1);
  pool.release(reused);
  assert.equal(monitor.getStats().activeConnections, 0);
  assert.equal(monitor.getStats().totalAcquired, 3);
  assert.equal(monitor.getStats().totalReleased, 3);
  await delay(35);
  assert.equal(monitor.detectLeaks().length, 0);
  pool.check();
  await delay(30);
  assert.equal(monitor.getStats().totalDestroyed, 2);
  await first.destroy();
  assert.equal(monitor.canAcquire(), false);
  await assert.rejects(async () => getPoolManager(first), /disconnected/);
  first.client.initializePool();
  const replacement = getPoolManager(first, 20, logger);
  assert.notEqual(replacement, monitor);
  await first.raw('SELECT 1');
  assert.equal(replacement.getStats().totalAcquired, 1);
  assert.equal(replacement.getStats().activeConnections, 0);
  assert.equal(monitor.getStats().totalAcquired, 3);
  await first.client.pool?.destroy();
  assert.throws(() => getPoolManager(first), /disconnected/);
  assert.equal(replacement.canAcquire(), false);
  await first.destroy();
  await second.destroy();
});

test('Tarn: query errors, rollback and acquisition failures leave no phantom checkouts', async (t) => {
  const sql = createPool(1);
  const monitor = getPoolManager(sql, 20, logger);
  await assert.rejects(sql.raw('SELECT 1 / 0'));
  assert.equal(monitor.getStats().activeConnections, 0);
  await assert.rejects(
    sql.transaction(async (trx) => {
      await trx.raw('SELECT 1');
      throw new Error('rollback requested');
    }),
    /rollback requested/
  );
  assert.equal(monitor.getStats().activeConnections, 0);
  const pool = sql.client.pool;
  assert.ok(pool);
  const resource: unknown = await pool.acquire().promise;
  t.after(() => {
    pool.release(resource);
  });
  const acquiredBefore = monitor.getStats().totalAcquired;
  await assert.rejects(pool.acquire().promise, /timeout|timed out/i);
  assert.equal(monitor.getStats().totalAcquired, acquiredBefore);
  assert.equal(monitor.getStats().activeConnections, 1);
  pool.release(resource);
  assert.equal(monitor.getStats().totalAcquired, monitor.getStats().totalReleased);
  assert.equal(monitor.detectLeaks().length, 0);
  await sql.destroy();
  // Missing private socket directory, not an arbitrary host or existing server.
  const unavailable = createPool(
    1,
    `postgresql://postgres@localhost/postgres?host=${encodeURIComponent(join(directory, 'absent-socket'))}`
  );
  const unavailableMonitor = getPoolManager(unavailable, 20, logger);
  await assert.rejects(unavailable.raw('SELECT 1'));
  assert.equal(unavailableMonitor.getStats().totalAcquired, 0);
  assert.equal(unavailableMonitor.getStats().activeConnections, 0);
  assert.equal(unavailableMonitor.detectLeaks().length, 0);
  await unavailable.destroy();
});

test('PostgreSQL: plaintext graph/node/edge metadata retains driver objects through save/load/save', async () => {
  configureEncryption(false);
  const database = await initializeDatabase(
    { type: 'postgres', connectionString: postgresUrl },
    logger
  );
  databases.add(database);
  const storage = new GraphStorage();
  const metadata = { label: 'x', nested: { values: [0, false, null] } };
  const firstId = randomUUID();
  const secondId = randomUUID();
  const now = new Date();
  const graph: Graph = {
    config: { name: randomUUID(), metadata },
    nodes: [firstId, secondId].map((id) => ({
      id,
      type: 'task',
      name: id,
      status: 'pending',
      priority: 0,
      dependencies: [],
      metadata,
      createdAt: now,
      updatedAt: now,
    })),
    edges: [
      {
        id: randomUUID(),
        fromNodeId: firstId,
        toNodeId: secondId,
        metadata,
        createdAt: now,
        updatedAt: now,
      },
    ],
    status: 'idle',
    executionLog: [],
    createdAt: now,
    updatedAt: now,
  };
  const id = await storage.saveGraph(graph);
  const loaded = await storage.loadGraph(id);
  assert.ok(loaded);
  assert.deepEqual(loaded.config.metadata, metadata);
  assert.deepEqual(loaded.nodes[0].metadata, metadata);
  assert.deepEqual(loaded.edges[0].metadata, metadata);
  const repeated = await storage.loadGraph(await storage.saveGraph(loaded));
  assert.deepEqual(repeated?.config.metadata, metadata);
  assert.deepEqual(repeated?.nodes[0].metadata, metadata);
  assert.deepEqual(repeated?.edges[0].metadata, metadata);
  await database.disconnect();
});

test('Database: disconnect/reinitialize clears cached database and pool managers', async () => {
  configureEncryption(false);
  const config = { connectionString: `sqlite://${join(directory, 'singleton.sqlite')}` };
  process.env.DB_URL = config.connectionString;
  const first = await initializeDatabase(config, logger);
  databases.add(first);
  const firstMonitor = getPoolManager(first.getKnex());
  assert.equal(await getDatabase(), first);
  await first.disconnect();
  assert.equal(firstMonitor.canAcquire(), false);
  const second = await getDatabase();
  databases.add(second);
  assert.notEqual(second, first);
  const secondMonitor = getPoolManager(second.getKnex());
  assert.notEqual(secondMonitor, firstMonitor);
  assert.equal(secondMonitor.getStats().activeConnections, 0);
  const third = await initializeDatabase(config, logger);
  databases.add(third);
  assert.notEqual(third, second);
  assert.equal(secondMonitor.canAcquire(), false);
  assert.equal(await getDatabase(), third);
  await third.disconnect();
  await first.connect();
  await first.initialize();
  assert.notEqual(getPoolManager(first.getKnex()), firstMonitor);
  await first.disconnect();
});
