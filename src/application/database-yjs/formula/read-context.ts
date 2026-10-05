import { ReadFieldValueContext } from '@/application/database-yjs/fields/formula';
import { parseRelationTypeOption } from '@/application/database-yjs/fields/relation/parse';
import { readHistoricalRelationText } from '@/application/database-yjs/relation/history';
import { readRollupCellSync } from '@/application/database-yjs/rollup/cache';
import { LoadViewOptions, MentionablePerson, YDatabase, YDatabaseRow, YDoc, YjsDatabaseKey } from '@/application/types';
import { canonicalizeUserUid } from '@/application/user-uid';

type RelatedViewLoader = (
  viewId: string,
  isSubDocument?: boolean,
  loadAwareness?: boolean,
  options?: LoadViewOptions
) => Promise<YDoc | null>;

export interface RelatedRowLoaders {
  /** Computed rollup targets resolve people in the owning workspace. */
  workspaceId?: string;
  loadView?: RelatedViewLoader;
  createRow?: (rowKey: string) => Promise<YDoc>;
  getViewIdFromDatabaseId?: (databaseId: string) => Promise<string | null>;
}

export interface MemberNames {
  getUserName: (uid: string) => string | undefined;
  getPersonName: (personId: string) => string | undefined;
}

/** Name lookups over a workspace member list (name, else email). */
export function memberNames(users: readonly MentionablePerson[]): MemberNames {
  const byUid = new Map<string, string>();
  const byPersonId = new Map<string, string>();

  users.forEach((user) => {
    const name = user.name?.trim() || user.email?.trim();

    if (!name) return;
    const uid = canonicalizeUserUid(user.uid);

    if (uid !== null) byUid.set(uid, name);
    if (user.person_id) byPersonId.set(user.person_id, name);
  });

  return {
    getUserName: (uid) => byUid.get(canonicalizeUserUid(uid) ?? uid),
    getPersonName: (personId) => byPersonId.get(personId),
  };
}

/** Snapshot-only dependencies: unresolved people and external rows retain their saved IDs. */
export function historicalFormulaRowContext(
  rowId: string,
  row: YDatabaseRow | undefined,
  { database, baseDoc, rows }: { database?: YDatabase; baseDoc: YDoc; rows?: Record<string, YDoc> | null }
): ReadFieldValueContext {
  return {
    getRelatedRowTitle: (relationField, relatedRowId) =>
      database
        ? readHistoricalRelationText(
            database,
            parseRelationTypeOption(relationField).database_id,
            [relatedRowId],
            rows ?? {}
          )
        : relatedRowId,
    getRollupValue: (fieldId) => {
      const rollupField = database?.get(YjsDatabaseKey.fields)?.get(fieldId);

      return database && row && rollupField
        ? readRollupCellSync({ baseDoc, database, rollupField, row, rowId, fieldId })
        : undefined;
    },
  };
}
