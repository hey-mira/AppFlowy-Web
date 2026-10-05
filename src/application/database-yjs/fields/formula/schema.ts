import { FieldType } from '@/application/database-yjs/database.type';
import { YDatabaseField, YDatabaseFields, YjsDatabaseKey } from '@/application/types';

/** The part of a field a formula needs: identity, type and the Yjs handle for cell decoding. */
export interface FormulaFieldSchema {
  id: string;
  name: string;
  type: FieldType;
  field: YDatabaseField;
}

const schemaCache = new WeakMap<
  YDatabaseFields,
  { version: number | undefined; schema: FormulaFieldSchema[]; signature: string }
>();
const signatureCache = new WeakMap<FormulaFieldSchema[], string>();

/**
 * Observer versions can lag inside a transaction or while a view is closed.
 * Validate the live fields at the read boundary, then share the signature and
 * schema metadata for the resulting snapshot throughout a native batch.
 */
function readCurrentFormulaSchema(fields: YDatabaseFields, version?: number): FormulaFieldSchema[] {
  const cached = schemaCache.get(fields);
  const schema: FormulaFieldSchema[] = [];
  const signatureEntries: unknown[] = [];

  fields.forEach((field, id) => {
    const name = String(field.get(YjsDatabaseKey.name) ?? '');
    const type = Number(field.get(YjsDatabaseKey.type)) as FieldType;

    schema.push({ id, name, type, field });
    signatureEntries.push([id, type, name, field.get(YjsDatabaseKey.type_option)?.toJSON()]);
  });

  const signature = stringifyFormulaConfig(signatureEntries);

  if (
    cached &&
    (version === undefined || cached.version === version) &&
    cached.signature === signature &&
    cached.schema.length === schema.length &&
    schema.every((entry, index) => entry.field === cached.schema[index].field)
  ) {
    return cached.schema;
  }

  // Capture type options now: the Yjs handles can mutate before a caller first
  // requests this snapshot's signature.
  signatureCache.set(schema, signature);
  schemaCache.set(fields, { version: version ?? cached?.version, schema, signature });
  return schema;
}

export function readFormulaSchema(fields?: YDatabaseFields): FormulaFieldSchema[] {
  return fields ? readCurrentFormulaSchema(fields) : [];
}

/** Share one validated schema snapshot among callers reading the same version. */
export function readFormulaSchemaForVersion(fields: YDatabaseFields | undefined, version: number): FormulaFieldSchema[] {
  return fields ? readCurrentFormulaSchema(fields, version) : [];
}

/** Changes whenever a field is added, removed, renamed, retyped or reconfigured. */
export function formulaSchemaSignature(schema: FormulaFieldSchema[]): string {
  let signature = signatureCache.get(schema);

  if (signature === undefined) {
    // last_modified has second resolution; multiple edits can share it.
    signature = stringifyFormulaConfig(
      schema.map((entry) => [entry.id, entry.type, entry.name, entry.field.get(YjsDatabaseKey.type_option)?.toJSON()])
    );
    signatureCache.set(schema, signature);
  }

  return signature;
}

/** Native Yrs type options can contain BigInts, including integers beyond Number's exact range. */
export function stringifyFormulaConfig(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item));
}
