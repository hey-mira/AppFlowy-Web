import * as Y from 'yjs';

import { FieldType } from '@/application/database-yjs/database.type';
import { YDatabaseField, YjsDatabaseKey } from '@/application/types';

import {
  formulaSchemaSignature,
  readFormulaSchema,
  readFormulaSchemaForVersion,
} from '../schema';

import { createFields } from './fixture';

describe('formula schema freshness', () => {
  afterEach(() => jest.restoreAllMocks());

  it('signs synced BigInt type options without losing precision or missing changes', () => {
    const fields = createFields([{ id: 'price', name: 'Price', type: FieldType.Number, typeOption: { format: 0 } }]);
    const typeOptions = fields.get('price').get(YjsDatabaseKey.type_option);
    // Native Yrs integers arrive as BigInts, which Yjs cannot insert directly.
    const serialized = jest.spyOn(typeOptions, 'toJSON').mockReturnValue({
      [FieldType.Number]: { format: 0n, metadata: { revision: 9007199254740992n } },
    });
    const first = readFormulaSchemaForVersion(fields, 0);
    const signature = formulaSchemaSignature(first);

    expect(formulaSchemaSignature(first.slice())).toBe(signature);
    expect(readFormulaSchemaForVersion(fields, 0)).toBe(first);
    serialized.mockReturnValue({
      [FieldType.Number]: { format: 0n, metadata: { revision: 9007199254740993n } },
    });
    const changed = readFormulaSchema(fields);

    expect(changed).not.toBe(first);
    expect(formulaSchemaSignature(changed)).not.toBe(signature);
  });

  it('shares validated snapshots until their version or content changes', () => {
    const fields = createFields([{ id: 'price', name: 'Price', type: FieldType.Number }]);
    const first = readFormulaSchemaForVersion(fields, 1);

    expect(readFormulaSchemaForVersion(fields, 1)).toBe(first);
    expect(readFormulaSchema(fields)).toBe(first);
    expect(readFormulaSchema(fields)).toBe(first);

    const nextVersion = readFormulaSchemaForVersion(fields, 2);

    expect(nextVersion).not.toBe(first);
    expect(readFormulaSchemaForVersion(fields, 2)).toBe(nextVersion);
    expect(readFormulaSchema(fields)).toBe(nextVersion);
  });

  it('captures type options before their live handles change, even if the signature was never requested', () => {
    const fields = createFields([
      { id: 'total', name: 'Total', type: FieldType.Formula, typeOption: { expression: '1' } },
    ]);
    const first = readFormulaSchemaForVersion(fields, 0);
    const option = fields.get('total').get(YjsDatabaseKey.type_option).get(String(FieldType.Formula));

    option.set(YjsDatabaseKey.expression, '2');
    const updated = readFormulaSchemaForVersion(fields, 0);

    expect(updated).not.toBe(first);
    expect(JSON.parse(formulaSchemaSignature(first))[0][3]).toEqual({
      [FieldType.Formula]: { expression: '1' },
    });
    expect(JSON.parse(formulaSchemaSignature(updated))[0][3]).toEqual({
      [FieldType.Formula]: { expression: '2' },
    });
    expect(readFormulaSchema(fields)).toBe(updated);
  });

  it('refreshes names and types without subscribers or a new version', () => {
    const fields = createFields([{ id: 'price', name: 'Price', type: FieldType.Number }]);
    const first = readFormulaSchemaForVersion(fields, 0);

    expect(first[0]).toMatchObject({ id: 'price', name: 'Price', type: FieldType.Number });
    fields.get('price').set(YjsDatabaseKey.name, 'Cost');
    fields.get('price').set(YjsDatabaseKey.type, FieldType.RichText);
    const reopened = readFormulaSchemaForVersion(fields, 0);

    expect(reopened).not.toBe(first);
    expect(reopened[0]).toMatchObject({ id: 'price', name: 'Cost', type: FieldType.RichText });
    expect(readFormulaSchema(fields)).toBe(reopened);
  });

  it('refreshes empty snapshots across additions and deletions', () => {
    const fields = createFields([]);
    const empty = readFormulaSchema(fields);
    const field = new Y.Map() as YDatabaseField;

    fields.set('price', field);
    field.set(YjsDatabaseKey.name, 'Price');
    field.set(YjsDatabaseKey.type, FieldType.Number);
    const added = readFormulaSchema(fields);

    expect(added.map((entry) => entry.id)).toEqual(['price']);
    fields.delete('price');
    const removed = readFormulaSchema(fields);

    expect(removed).toEqual([]);
    expect(removed).not.toBe(added);
    expect(readFormulaSchema(fields)).toBe(removed);
    expect(removed.find((entry) => entry.id === 'price')).toBeUndefined();
  });

  it('replaces detached field handles even when all serialized contents match', () => {
    const fields = createFields([{ id: 'price', name: 'Price', type: FieldType.Number }]);
    const first = readFormulaSchemaForVersion(fields, 0);
    const replacement = new Y.Map(Object.entries(fields.get('price').toJSON())) as YDatabaseField;

    fields.set('price', replacement);
    const replaced = readFormulaSchema(fields);

    expect(formulaSchemaSignature(replaced)).toBe(formulaSchemaSignature(first));
    expect(replaced).not.toBe(first);
    expect(replaced[0].field).toBe(replacement);
    replacement.set(YjsDatabaseKey.name, 'Cost');
    expect(readFormulaSchema(fields)[0].name).toBe('Cost');
  });

  it('reads every mutation made between schema accesses inside one transaction', () => {
    const fields = createFields([
      { id: 'total', name: 'Total', type: FieldType.Formula, typeOption: { expression: '1' } },
    ]);
    const initial = readFormulaSchemaForVersion(fields, 0);
    const option = fields.get('total').get(YjsDatabaseKey.type_option).get(String(FieldType.Formula));

    fields.doc!.transact(() => {
      option.set(YjsDatabaseKey.expression, '2');
      const second = readFormulaSchemaForVersion(fields, 0);

      expect(formulaSchemaSignature(second)).not.toBe(formulaSchemaSignature(initial));
      option.set(YjsDatabaseKey.expression, '3');
      const third = readFormulaSchema(fields);

      expect(formulaSchemaSignature(third)).not.toBe(formulaSchemaSignature(second));
      expect(JSON.parse(formulaSchemaSignature(third))[0][3][FieldType.Formula].expression).toBe('3');
    });
  });

  it('supports the first schema read occurring inside an already open transaction', () => {
    const fields = createFields([{ id: 'price', name: 'Price', type: FieldType.Number }]);

    fields.doc!.transact(() => {
      const first = readFormulaSchemaForVersion(fields, 0);

      fields.get('price').set(YjsDatabaseKey.name, 'Cost');
      const updated = readFormulaSchema(fields);

      expect(updated).not.toBe(first);
      expect(updated[0].name).toBe('Cost');
    });
  });

  it('refreshes synchronously inside an observer registered before the first schema read', () => {
    const fields = createFields([{ id: 'price', name: 'Price', type: FieldType.Number }]);
    const names: string[] = [];
    const observer = () => {
      names.push(readFormulaSchema(fields)[0].name);
    };

    fields.observeDeep(observer);
    const first = readFormulaSchemaForVersion(fields, 0);

    fields.get('price').set(YjsDatabaseKey.name, 'Cost');
    expect(names).toEqual(['Cost']);
    fields.unobserveDeep(observer);
  });

  it('does not conflate identical schemas belonging to different fields maps', () => {
    const specs = [{ id: 'price', name: 'Price', type: FieldType.Number }];
    const firstFields = createFields(specs);
    const secondFields = createFields(specs);
    const first = readFormulaSchema(firstFields);
    const second = readFormulaSchema(secondFields);

    expect(second).not.toBe(first);
    firstFields.get('price').set(YjsDatabaseKey.name, 'Cost');
    expect(readFormulaSchema(firstFields)[0].name).toBe('Cost');
    expect(readFormulaSchema(secondFields)).toBe(second);
    expect(second[0].name).toBe('Price');
  });
});
