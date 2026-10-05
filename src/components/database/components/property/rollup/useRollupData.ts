import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { isNumericCalculation } from '@/application/database-yjs/calculation';
import { useDatabase, useDatabaseContext, useReadOnly } from '@/application/database-yjs/context';
import { CalculationType, FieldType, RollupDisplayMode } from '@/application/database-yjs/database.type';
import { useUpdateRollupTypeOption } from '@/application/database-yjs/dispatch';
import { parseRelationTypeOption } from '@/application/database-yjs/fields/relation/parse';
import { usesRollupCondition } from '@/application/database-yjs/fields/rollup/condition';
import { parseRollupTypeOption, parseRollupVisualizationOption } from '@/application/database-yjs/fields/rollup/parse';
import { RollupShowAsType } from '@/application/database-yjs/fields/rollup/rollup.type';
import { parseSelectOptionTypeOptions } from '@/application/database-yjs/fields/select-option/parse';
import { formulaPredicateFieldType } from '@/application/database-yjs/formula/filter';
import { useNativeFormulaRuntime } from '@/application/database-yjs/formula/native-runtime';
import { nativeFormulaPropertyInSession } from '@/application/database-yjs/formula/native-session';
import { ComputedSession, releaseComputedFormulaEngines } from '@/application/database-yjs/rollup/computed';
import { rememberRollupTarget, migrateRollupFilters } from '@/application/database-yjs/rollup/filter';
import { useFieldSelector } from '@/application/database-yjs/selector';
import { subscribeSharedYjsDeep } from '@/application/database-yjs/shared-yjs-observer';
import { YDatabaseField, YDoc, YjsDatabaseKey, YjsEditorKey } from '@/application/types';

import { getAvailableRollupCalculations } from './utils';

export type RelationFieldOption = {
  id: string;
  name: string;
  databaseId: string;
};

export type TargetFieldOption = {
  id: string;
  name: string;
  type: FieldType;
  effectiveType: FieldType;
  field: YDatabaseField;
};

type RelatedFieldsState = {
  databaseId: string;
  doc?: YDoc;
  fields: TargetFieldOption[];
  loading: boolean;
};

function readTargetFields(doc: YDoc | null): TargetFieldOption[] {
  if (!doc) return [];

  const sharedRoot = doc.getMap(YjsEditorKey.data_section);
  const relatedDatabase = sharedRoot?.get(YjsEditorKey.database);
  const fields = relatedDatabase?.get(YjsDatabaseKey.fields);

  if (!fields) return [];

  const options: TargetFieldOption[] = [];

  fields.forEach((field: YDatabaseField, id: string) => {
    const type = Number(field.get(YjsDatabaseKey.type)) as FieldType;

    options.push({
      id,
      name: field.get(YjsDatabaseKey.name) || '',
      type,
      effectiveType: type === FieldType.Formula ? formulaPredicateFieldType(field, fields) : type,
      field,
    });
  });

  return options;
}

export function useRollupData(fieldId: string) {
  const database = useDatabase();
  const readOnly = useReadOnly();
  const { field, clock } = useFieldSelector(fieldId);
  const context = useDatabaseContext();
  const { loadView, getViewIdFromDatabaseId } = context;
  const updateRollupTypeOption = useUpdateRollupTypeOption(fieldId);

  const rollupOption = useMemo(() => {
    const parsed = field ? parseRollupTypeOption(field) : null;

    // The Y.Map reference is stable, so the selector clock is part of the snapshot.
    void clock;

    return {
      relation_field_id: parsed?.relation_field_id ?? '',
      target_field_id: parsed?.target_field_id ?? '',
      calculation_type: parsed?.calculation_type === undefined ? CalculationType.Count : parsed.calculation_type,
      show_as: parsed?.show_as === undefined ? RollupDisplayMode.Calculated : parsed.show_as,
      condition_value: parsed?.condition_value ?? '',
      visualization: parseRollupVisualizationOption(parsed),
    };
  }, [field, clock]);

  const [relationFields, setRelationFields] = useState<RelationFieldOption[]>([]);
  const [relatedFieldsState, setRelatedFieldsState] = useState<RelatedFieldsState>({
    databaseId: '',
    fields: [],
    loading: false,
  });
  const relationSelectionRequest = useRef(0);
  const relatedDocPromises = useRef(new Map<string, Promise<YDoc | null>>());

  useEffect(() => {
    const fields = database?.get(YjsDatabaseKey.fields);

    if (!fields) {
      setRelationFields([]);
      return;
    }

    const updateFields = () => {
      const options: RelationFieldOption[] = [];

      fields.forEach((relationField, id) => {
        if (Number(relationField.get(YjsDatabaseKey.type)) !== FieldType.Relation) return;

        options.push({
          id,
          name: relationField.get(YjsDatabaseKey.name) || '',
          databaseId: parseRelationTypeOption(relationField)?.database_id ?? '',
        });
      });
      setRelationFields(options);
    };

    updateFields();
    fields.observeDeep(updateFields);
    return () => {
      fields.unobserveDeep(updateFields);
    };
  }, [database]);

  const relatedDatabaseId =
    relationFields.find((relation) => relation.id === rollupOption.relation_field_id)?.databaseId ?? '';

  const loadRelatedDoc = useCallback(
    (databaseId: string) => {
      const cached = relatedDocPromises.current.get(databaseId);

      if (cached) return cached;

      const promise = (async () => {
        const viewId = await getViewIdFromDatabaseId?.(databaseId);

        return viewId
          ? (await loadView?.(viewId, false, false, { databaseId, databaseMetadataOnly: true })) ?? null
          : null;
      })();

      relatedDocPromises.current.set(databaseId, promise);
      void promise.then(
        (doc) => {
          if (!doc && relatedDocPromises.current.get(databaseId) === promise) {
            relatedDocPromises.current.delete(databaseId);
          }
        },
        () => {
          if (relatedDocPromises.current.get(databaseId) === promise) {
            relatedDocPromises.current.delete(databaseId);
          }
        }
      );
      return promise;
    },
    [getViewIdFromDatabaseId, loadView]
  );

  useEffect(() => {
    let cancelled = false;
    let stopObserving: (() => void) | undefined;

    if (!relatedDatabaseId) {
      setRelatedFieldsState((current) =>
        current.databaseId || current.fields.length > 0 || current.loading
          ? { databaseId: '', fields: [], loading: false }
          : current
      );
      return;
    }

    setRelatedFieldsState({ databaseId: relatedDatabaseId, fields: [], loading: true });
    void loadRelatedDoc(relatedDatabaseId)
      .then((doc) => {
        if (cancelled) return;

        if (!doc) {
          setRelatedFieldsState({ databaseId: relatedDatabaseId, fields: [], loading: false });
          return;
        }

        const sharedRoot = doc.getMap(YjsEditorKey.data_section);

        const updateRelatedFields = () => {
          const fields = sharedRoot.get(YjsEditorKey.database)?.get(YjsDatabaseKey.fields);

          setRelatedFieldsState((current) =>
            current.databaseId === relatedDatabaseId
              ? { databaseId: relatedDatabaseId, doc, fields: readTargetFields(doc), loading: !fields }
              : current
          );
        };

        // loadView may resolve before the metadata document has hydrated.
        // Subscribe to the root first so database/field insertion cannot land
        // between the initial read and observer attachment.
        stopObserving = subscribeSharedYjsDeep(sharedRoot, updateRelatedFields);
        updateRelatedFields();
      })
      .catch(() => {
        if (!cancelled) {
          relatedDocPromises.current.delete(relatedDatabaseId);
          setRelatedFieldsState({ databaseId: relatedDatabaseId, fields: [], loading: false });
        }
      });

    return () => {
      cancelled = true;
      stopObserving?.();
    };
  }, [loadRelatedDoc, relatedDatabaseId]);

  // Effects run after render. Hide the previous relation's schema immediately
  // when the option changes so stale fields can never be selected or persisted.
  const relatedDoc = relatedFieldsState.databaseId === relatedDatabaseId ? relatedFieldsState.doc : undefined;
  const relatedContext = useMemo(
    () =>
      relatedDoc
        ? {
            ...context,
            databaseDoc: relatedDoc,
            databasePageId: relatedDoc.guid,
            activeViewId: relatedDoc.guid,
            rowMap: null,
          }
        : undefined,
    [context, relatedDoc]
  );
  const native = useNativeFormulaRuntime({
    enabled: Boolean(relatedDoc && relatedFieldsState.fields.some((target) => target.type === FieldType.Formula)),
    context: relatedContext,
  });
  const relatedFields = useMemo(() => {
    // Native metadata arrives independently of Yjs schema events. No row is
    // needed to resolve static type, and Union/Unknown keep the conservative UI.
    void native.properties;
    return relatedFieldsState.databaseId === relatedDatabaseId
      ? relatedFieldsState.fields.map((target) => ({
          ...target,
          effectiveType: target.type === FieldType.Formula ? formulaPredicateFieldType(target.field) : target.type,
        }))
      : [];
  }, [relatedFieldsState, relatedDatabaseId, native.properties]);
  const loadingRelated =
    Boolean(relatedDatabaseId) && (relatedFieldsState.databaseId !== relatedDatabaseId || relatedFieldsState.loading);

  const targetField = relatedFields.find((target) => target.id === rollupOption.target_field_id);
  const targetState = targetField && native.properties.get(targetField.id);
  const targetOutput =
    targetState && 'Formula' in targetState && targetState.Formula.status !== 'NotReady'
      ? targetState.Formula.status.Ready.output_type
      : undefined;
  const pendingFormulaType = targetField?.type === FieldType.Formula && targetOutput === undefined;
  const uncertainFormulaType =
    targetOutput === 'Unknown' || (typeof targetOutput === 'object' && 'Union' in targetOutput);

  useEffect(() => {
    if (!field || !targetField || pendingFormulaType) return;
    rememberRollupTarget(field, targetField.field);
    if (!readOnly) database.doc?.transact(() => migrateRollupFilters(database, fieldId, targetField.effectiveType));
  }, [database, field, fieldId, targetField, readOnly, pendingFormulaType]);

  const availableCalculations = useMemo(
    () => getAvailableRollupCalculations(targetField?.effectiveType),
    [targetField?.effectiveType]
  );

  // Keep imported/remote options valid even when another client changes the target.
  useEffect(() => {
    if (readOnly || targetField?.type === undefined || pendingFormulaType) return;
    if (availableCalculations.includes(rollupOption.calculation_type as CalculationType)) return;
    // Existing numeric operations validate the actual native values. A static
    // Unknown/Union cannot prove them incompatible or justify rewriting Count.
    if (uncertainFormulaType && isNumericCalculation(rollupOption.calculation_type as CalculationType)) return;

    updateRollupTypeOption({ calculation_type: CalculationType.Count, condition_value: '' });
  }, [
    availableCalculations,
    rollupOption.calculation_type,
    targetField?.type,
    updateRollupTypeOption,
    readOnly,
    pendingFormulaType,
    uncertainFormulaType,
  ]);

  useEffect(() => {
    if (
      readOnly ||
      usesRollupCondition(rollupOption.calculation_type as CalculationType) ||
      !rollupOption.condition_value
    )
      return;

    updateRollupTypeOption({ condition_value: '' });
  }, [rollupOption.calculation_type, rollupOption.condition_value, updateRollupTypeOption, readOnly]);

  const selectRelationField = useCallback(
    async (relation: RelationFieldOption) => {
      const request = relationSelectionRequest.current + 1;

      relationSelectionRequest.current = request;
      updateRollupTypeOption({
        relation_field_id: relation.id,
        target_field_id: '',
        calculation_type: CalculationType.Count,
        show_as: RollupDisplayMode.Calculated,
        condition_value: '',
        visualization_type: RollupShowAsType.Number,
      });

      if (!relation.databaseId) return;

      try {
        const doc = await loadRelatedDoc(relation.databaseId);
        const firstTarget = readTargetFields(doc)[0];

        if (doc && firstTarget?.type === FieldType.Formula) {
          const session: ComputedSession = { path: new Set(), now: Date.now(), nativeFormulaEngines: new Map() };

          try {
            await nativeFormulaPropertyInSession(
              {
                database: doc.getMap(YjsEditorKey.data_section).get(YjsEditorKey.database),
                baseDoc: doc,
                fieldId: firstTarget.id,
              },
              session
            );
            firstTarget.effectiveType = formulaPredicateFieldType(firstTarget.field);
          } finally {
            releaseComputedFormulaEngines(session);
          }
        }

        const latestOption = parseRollupTypeOption(field);

        if (
          relationSelectionRequest.current !== request ||
          latestOption?.relation_field_id !== relation.id ||
          latestOption.target_field_id ||
          !firstTarget
        ) {
          return;
        }

        updateRollupTypeOption({
          target_field_type: firstTarget.effectiveType,
          target_field_id: firstTarget.id,
          calculation_type: CalculationType.Count,
          condition_value: '',
        });
      } catch {
        relatedDocPromises.current.delete(relation.databaseId);
      }
    },
    [field, loadRelatedDoc, updateRollupTypeOption]
  );

  const selectTargetField = useCallback(
    (target: TargetFieldOption) => {
      relationSelectionRequest.current += 1;
      const currentCalculation = rollupOption.calculation_type as CalculationType;
      const liveType = Number(target.field.get(YjsDatabaseKey.type) ?? target.type) as FieldType;
      const effectiveType = liveType === FieldType.Formula ? formulaPredicateFieldType(target.field) : liveType;
      const nextCalculation = getAvailableRollupCalculations(effectiveType).includes(currentCalculation)
        ? currentCalculation
        : CalculationType.Count;

      updateRollupTypeOption({
        target_field_type: effectiveType,
        target_field_id: target.id,
        calculation_type: nextCalculation,
        condition_value: '',
      });
    },
    [rollupOption.calculation_type, updateRollupTypeOption]
  );

  const selectOptions = useMemo(() => {
    if (!targetField || ![FieldType.SingleSelect, FieldType.MultiSelect].includes(targetField.type)) return [];

    return parseSelectOptionTypeOptions(targetField.field)?.options || [];
  }, [targetField]);

  return {
    rollupOption,
    relationFields,
    relatedFields,
    targetField,
    selectOptions,
    loadingRelated,
    selectRelationField,
    selectTargetField,
    updateRollupTypeOption,
  };
}
