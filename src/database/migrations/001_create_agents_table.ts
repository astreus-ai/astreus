import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable('agents', (table) => {
    table.increments('id').primary();
    table.string('name').notNullable().unique();
    table.text('description');
    table.string('model');
    table.float('temperature');
    table.integer('maxTokens');
    table.text('systemPrompt');
    table.boolean('memory').defaultTo(false);
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTable('agents');
}