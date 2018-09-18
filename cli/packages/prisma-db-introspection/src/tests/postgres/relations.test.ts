import { Introspector } from '../../Introspector'
import { Client } from 'pg'
import { connectionDetails } from './connectionDetails'
import { PostgresConnector } from '../../connectors/PostgresConnector';

function introspect(): Promise<{ numTables: number; sdl: string }> {
  const pgConnector = new PostgresConnector(connectionDetails)
  return new Introspector(pgConnector).introspect('DatabaseIntrospector')
}

async function testSchema(sql: string) {
  const client = new Client(connectionDetails)
  await client.connect()
  await client.query('DROP SCHEMA IF EXISTS DatabaseIntrospector cascade;')
  await client.query('CREATE SCHEMA DatabaseIntrospector;')
  await client.query('SET search_path TO DatabaseIntrospector;')
  await client.query(sql)

  expect(await introspect()).toMatchSnapshot()

  await client.end()
}

describe('Introspector', () => {
  test('relation with relation table', async () => {
    await testSchema(`CREATE TABLE product (
      id         serial PRIMARY KEY  -- implicit primary key constraint
    , product    text NOT NULL
    );
    
    CREATE TABLE bill (
      id       serial PRIMARY KEY
    , bill     text NOT NULL
    );
    
    CREATE TABLE bill_product (
      bill_id    int REFERENCES bill (id) ON UPDATE CASCADE ON DELETE CASCADE
    , product_id int REFERENCES product (id) ON UPDATE CASCADE
    );`)
  })

  test('relation with relation table with extra column', async () => {
    await testSchema(`CREATE TABLE product (
      id         serial PRIMARY KEY  -- implicit primary key constraint
    , product    text NOT NULL
    );
    
    CREATE TABLE bill (
      id       serial PRIMARY KEY
    , bill     text NOT NULL
    );
    
    CREATE TABLE bill_product (
      bill_id    int REFERENCES bill (id) ON UPDATE CASCADE ON DELETE CASCADE
    , product_id int REFERENCES product (id) ON UPDATE CASCADE
    , some_other_column text NOT NULL
    );`)
  })

  test('relation with inline relation column', async () => {
    await testSchema(`CREATE TABLE product (
      id           serial PRIMARY KEY  -- implicit primary key constraint
    , description  text NOT NULL
    );
    
    CREATE TABLE bill (
      id         serial PRIMARY KEY
    , bill       text NOT NULL
    , product_id int REFERENCES product (id) ON UPDATE CASCADE
    );`)
  })

  test('relation with inline relation column NOT NULL', async () => {
    await testSchema(`CREATE TABLE product (
      id           serial PRIMARY KEY  -- implicit primary key constraint
    , description  text NOT NULL
    );
    
    CREATE TABLE bill (
      id         serial PRIMARY KEY
    , bill       text NOT NULL
    , product_id int NOT NULL REFERENCES product (id) ON UPDATE CASCADE
    );`)
  })
})
