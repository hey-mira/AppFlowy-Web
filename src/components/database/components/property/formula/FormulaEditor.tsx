import {
  FocusEvent,
  forwardRef,
  KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import {
  useDatabase,
  useDatabaseContext,
  useDatabaseFields,
  useDatabaseView,
  useRowMap,
} from '@/application/database-yjs/context';
import { decodeCellToText } from '@/application/database-yjs/decode';
import { FormulaFieldSchema, readFormulaSchemaForVersion } from '@/application/database-yjs/fields/formula/schema';
import { typeToString } from '@/application/database-yjs/fields/formula/values';
import { appFlowyFormulaType } from '@/application/database-yjs/formula/native-values';
import { useDatabaseFieldsVersion } from '@/application/database-yjs/hooks/useDatabaseFieldsVersion';
import { getInlineViewRowOrders, materializeVisibleRowOrders } from '@/application/database-yjs/row-order-visibility';
import { Row, usePrimaryFieldId } from '@/application/database-yjs/selector';
import { YDatabaseRow, YjsDatabaseKey, YjsEditorKey } from '@/application/types';
import { ReactComponent as ArrowDownIcon } from '@/assets/icons/alt_arrow_down.svg';
import { ReactComponent as WarningSvg } from '@/assets/icons/warning.svg';
import { FieldTypeIcon } from '@/components/database/components/field/FieldTypeIcon';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { SearchInput } from '@/components/ui/search-input';
import { cn } from '@/lib/utils';

import { FORMULA_BUILTIN_DOCS, FORMULA_FUNCTION_DOCS } from './formula-docs';
import { FormulaDocsItem, FormulaDocsPanel } from './FormulaDocsPanel';
import { FormulaSourceChange, FormulaSourceInput, FormulaSourceInputHandle } from './FormulaSourceInput';
import {
  bindNativePropertyNames,
  NativeDraftAnalysis,
  NativeFormulaEditorSession,
  nativeEditorProperties,
  retainNativeSession,
} from './native-editor';
import { useNativeFormulaPreview } from './use-native-preview';

import type { CompletionItem, FormulaDefinition, FormulaEdit, SignatureHelp } from '@notion-formula/sdk';

const PREVIEW_ROW_LIMIT = 50;
const AUTOCOMPLETE_LIMIT = 8;

export interface FormulaEditorProps {
  fieldId: string;
  /** Canonical source; property chips show their current display names. */
  value: string;
  onChange: (value: string) => void;
  initialPreviewRowId?: string;
  onSubmit?: () => void;
  onAutocompleteOpenChange?: (open: boolean) => void;
  onValidationChange?: (valid: boolean) => void;
  saveError?: string;
}

export interface FormulaEditorHandle {
  definition: (schema: FormulaFieldSchema[]) => Promise<FormulaDefinition | null>;
}

function completionLabel(item: CompletionItem, schema: FormulaFieldSchema[]) {
  return item.kind === 'Property' ? schema.find((entry) => entry.id === item.label)?.name ?? item.label : item.label;
}

function docsItem(item: CompletionItem, schema: FormulaFieldSchema[]): FormulaDocsItem | null {
  if (item.kind === 'Property') {
    const entry = schema.find((entry) => entry.id === item.label);

    return entry ? { kind: 'property', entry } : null;
  }

  const name = item.label.replace(/^\./, '').replace(/\(\)$/, '');
  const builtin = FORMULA_BUILTIN_DOCS.find((spec) => spec.name === name);

  if (builtin) return { kind: 'builtin', spec: builtin };
  if (!item.kind.startsWith('Function')) return null;
  const spec = FORMULA_FUNCTION_DOCS.find((spec) => spec.name === name) ?? {
    name,
    signature: item.detail ?? item.label,
    description: item.detail ?? '',
    examples: [],
  };

  return { kind: 'function', spec };
}

function Signature({ help }: { help: SignatureHelp }) {
  const signature = help.signatures[help.active_signature];

  return (
    <div
      data-testid='formula-signature-help'
      className='shrink-0 whitespace-pre-wrap font-mono text-xs text-text-secondary'
    >
      {signature?.segments.map((segment, index) => (
        <span
          key={index}
          className={
            segment.kind === 'Param' && segment.param_index === help.active_parameter
              ? 'font-semibold text-text-primary'
              : undefined
          }
        >
          {segment.kind === 'Ellipsis'
            ? '…'
            : segment.kind === 'Param'
            ? `${segment.name}: ${segment.ty}`
            : segment.text}
        </span>
      ))}
    </div>
  );
}

/** Native analysis refreshes independently from the long-lived Slate document. */
export const FormulaEditor = forwardRef<FormulaEditorHandle, FormulaEditorProps>(function FormulaEditor(
  { fieldId, value, onChange, initialPreviewRowId, onSubmit, onAutocompleteOpenChange, onValidationChange, saveError },
  ref
) {
  const { t } = useTranslation();
  const fields = useDatabaseFields();
  const fieldsVersion = useDatabaseFieldsVersion();
  const schema = readFormulaSchemaForVersion(fields, fieldsVersion);
  const context = useDatabaseContext();
  const database = useDatabase();
  const view = useDatabaseView();
  const rowMap = useRowMap();
  const primaryFieldId = usePrimaryFieldId();
  const session = useMemo(() => {
    void context.databaseDoc;
    return new NativeFormulaEditorSession(fieldId);
  }, [context.databaseDoc, fieldId]);
  const inputRef = useRef<FormulaSourceInputHandle>(null);
  const [caret, setCaret] = useState(value.length);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<FormulaDocsItem | null>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(true);
  const [initialized, setInitialized] = useState(false);
  const [actionError, setActionError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [previewRowId, setPreviewRowId] = useState(initialPreviewRowId);
  const editSchema = useRef(schema);
  const initialExpression = useRef(value);
  const boundIds = useRef(new Set(schema.map((entry) => entry.id)));
  const latest = useRef({ value, schema, caret, session, revision: 0 });
  const [snapshot, setSnapshot] = useState<{
    source: string;
    schema: FormulaFieldSchema[];
    caret: number;
    analysis?: NativeDraftAnalysis;
    error?: string;
  }>();

  if (
    latest.current.value !== value ||
    latest.current.schema !== schema ||
    latest.current.caret !== caret ||
    latest.current.session !== session
  ) {
    latest.current = { value, schema, caret, session, revision: latest.current.revision + 1 };
  }

  useEffect(() => retainNativeSession(session), [session]);
  useEffect(() => {
    const revision = latest.current.revision;
    let cancelled = false;
    const current = () => !cancelled && latest.current.revision === revision && latest.current.session === session;
    const properties = nativeEditorProperties(schema);
    const timer = setTimeout(() => {
      void session
        .analyze(properties, value, caret)
        .then(async (analysis) => {
          if (!current()) return;
          if (value === initialExpression.current)
            analysis.state.property_references.forEach((reference) => boundIds.current.add(reference.property_id));
          const binding = bindNativePropertyNames(analysis.state, editSchema.current, boundIds.current);

          if (binding.edit.edits.length > 0) {
            const result = await session.apply(binding.edit, caret);

            if (!current()) return;
            inputRef.current?.applyEdits(binding.edit.edits, result.cursor, true);
            return;
          }

          analysis.state.property_references.forEach((reference) => {
            if (schema.some((entry) => entry.id === reference.property_id)) boundIds.current.add(reference.property_id);
          });
          setSnapshot({ source: value, schema, caret, analysis, error: binding.ambiguous[0] });
          setInitialized(true);
          setActionError('');
        })
        .catch((error: unknown) => {
          if (current())
            setSnapshot({
              source: value,
              schema,
              caret,
              error: error instanceof Error ? error.message : 'Formula analysis failed',
            });
        });
    }, 70);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [session, value, schema, caret, refresh]);

  const analysis = snapshot?.source === value && snapshot.schema === schema ? snapshot.analysis : undefined;
  const help = snapshot?.caret === caret ? analysis?.help : undefined;
  const bindingError = snapshot?.source === value && snapshot.schema === schema ? snapshot.error : undefined;
  const valid = Boolean(analysis && !bindingError && analysis.state.diagnostics.length === 0);

  useEffect(() => onValidationChange?.(valid), [valid, onValidationChange]);
  useImperativeHandle(
    ref,
    () => ({
      definition: async (freshSchema) => {
        const before = latest.current;
        const definition = await session.definition(nativeEditorProperties(freshSchema), before.value);

        if (latest.current.value !== before.value || latest.current.session !== session) return null;
        setRefresh((revision) => revision + 1);
        return definition;
      },
    }),
    [session]
  );

  const applyNativeEdit = useCallback(
    async (edit: FormulaEdit, targetCursor?: number) => {
      const before = latest.current;

      if (!analysis || analysis.state.version !== edit.base_version) return;
      try {
        const result = await session.apply(edit, before.caret);

        if (latest.current.revision !== before.revision || latest.current.session !== session) return;
        inputRef.current?.applyEdits(edit.edits, targetCursor ?? result.cursor);
        setDismissed(true);
      } catch (error) {
        if (latest.current.revision === before.revision)
          setActionError(error instanceof Error ? error.message : 'Formula edit failed');
      }
    },
    [analysis, session]
  );
  const format = useCallback(async () => {
    const before = latest.current;

    try {
      const edit = await session.format();

      if (latest.current.revision !== before.revision || latest.current.session !== session) return;
      await applyNativeEdit(edit);
    } catch (error) {
      if (latest.current.revision === before.revision)
        setActionError(error instanceof Error ? error.message : 'Formula could not be formatted');
    }
  }, [applyNativeEdit, session]);

  const rowIds = useMemo(() => {
    const orders = view?.get(YjsDatabaseKey.row_orders)?.toJSON() as Row[] | undefined;
    const canonical = getInlineViewRowOrders(database)?.toJSON() as Row[] | undefined;

    return (materializeVisibleRowOrders(orders, canonical) ?? []).map((row) => row.id);
  }, [database, view]);
  const previewRows = useMemo(() => {
    const primaryField = schema.find((entry) => entry.id === primaryFieldId)?.field;
    const ids = rowIds.slice(0, PREVIEW_ROW_LIMIT);

    if (initialPreviewRowId && !ids.includes(initialPreviewRowId) && rowIds.includes(initialPreviewRowId))
      ids.unshift(initialPreviewRowId);
    return ids
      .map((id) => {
        const row = rowMap?.[id]?.getMap(YjsEditorKey.data_section).get(YjsEditorKey.database_row) as
          | YDatabaseRow
          | undefined;
        const cell = primaryFieldId ? row?.get(YjsDatabaseKey.cells)?.get(primaryFieldId) : undefined;

        return {
          id,
          row,
          label:
            cell && primaryField
              ? decodeCellToText(cell, primaryField).trim()
              : t('grid.formula.untitledRow', { defaultValue: 'Row {{index}}', index: rowIds.indexOf(id) + 1 }),
        };
      })
      .filter((entry) => entry.row);
  }, [schema, rowIds, rowMap, primaryFieldId, initialPreviewRowId, t]);
  const previewRow = previewRows.find((row) => row.id === previewRowId) ?? previewRows[0];
  const preview = useNativeFormulaPreview({
    fieldId,
    expression: value,
    schema,
    row: previewRow?.row,
    rowId: previewRow?.id ?? '',
    valid,
  });

  const suggestions = useMemo(() => {
    if (!help || dismissed) return [];
    const completion = help.completion;
    const preferred = completion.preferred_indices.map((index) => completion.items[index]);
    const query = value.slice(completion.replace.start, Math.min(caret, completion.replace.end)).toLowerCase();
    const named = query
      ? completion.items.filter(
          (item) => item.kind === 'Property' && completionLabel(item, schema).toLowerCase().includes(query)
        )
      : [];

    return [...new Set([...named, ...preferred, ...completion.items])].slice(0, AUTOCOMPLETE_LIMIT);
  }, [help, dismissed, value, caret, schema]);

  useEffect(() => setActive(0), [value]);
  useEffect(() => onAutocompleteOpenChange?.(suggestions.length > 0), [suggestions.length, onAutocompleteOpenChange]);
  const accept = useCallback(
    (item: CompletionItem) => {
      if (!help || item.is_disabled || !item.primary_edit) return;
      void applyNativeEdit(
        { base_version: help.base_version, edits: [item.primary_edit, ...item.additional_edits] },
        item.cursor ?? undefined
      );
    },
    [help, applyNativeEdit]
  );
  const insert = useCallback((text: string, cursor = text.length) => {
    inputRef.current?.insert(text, cursor);
    setDismissed(true);
  }, []);
  const handleSourceChange = useCallback(
    (next: string, change: FormulaSourceChange) => {
      if (change === 'edit') editSchema.current = schema;
      latest.current = { ...latest.current, value: next, revision: latest.current.revision + 1 };
      onChange(next);
      if (change === 'edit') setDismissed(false);
    },
    [onChange, schema]
  );
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.nativeEvent.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        onSubmit?.();
        return;
      }

      if (suggestions.length > 0) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          setActive((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
          return;
        }

        if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
          event.preventDefault();
          accept(suggestions[active] ?? suggestions[0]);
          return;
        }

        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setDismissed(true);
          return;
        }
      }

      if (event.key === 'Tab') {
        event.preventDefault();
        insert('  ', 2);
      }
    },
    [suggestions, active, accept, insert, onSubmit]
  );
  const blur = useCallback((event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDismissed(true);
  }, []);

  const catalogue = useMemo(() => {
    const query = search.trim().toLowerCase();

    return (analysis?.catalogue ?? []).filter(
      (item) => !query || completionLabel(item, schema).toLowerCase().includes(query)
    );
  }, [analysis, search, schema]);
  const selectedItem =
    selected?.kind === 'property' ? schema.find((entry) => entry.id === selected.entry.id) : undefined;
  const currentSelected =
    selected?.kind === 'property'
      ? selectedItem
        ? { kind: 'property' as const, entry: selectedItem }
        : null
      : selected;
  const documented = suggestions[active]
    ? docsItem(suggestions[active], schema)
    : currentSelected ?? (catalogue[0] ? docsItem(catalogue[0], schema) : null);
  const error = saveError || bindingError || actionError || analysis?.state.diagnostics[0]?.message || preview?.error;

  return (
    <div
      className='flex min-h-0 flex-1 flex-col gap-3'
      data-testid='formula-editor'
      data-draft-version={analysis ? String(analysis.state.version) : undefined}
      data-document-revision={fieldsVersion}
    >
      <div className='relative shrink-0' onBlur={blur}>
        <FormulaSourceInput
          ref={inputRef}
          value={value}
          schema={schema}
          nativeState={analysis?.state}
          readOnly={!initialized}
          onChange={handleSourceChange}
          onCaretChange={setCaret}
          onKeyDown={handleKeyDown}
          ariaLabel={t('grid.formula.title', { defaultValue: 'Formula' })}
          placeholder={t('grid.formula.placeholder', { defaultValue: 'Type a formula, e.g. prop("Price") * 2' })}
          className='appflowy-scroller max-h-[min(40vh,160px)] min-h-[72px] w-full overflow-y-auto overscroll-y-contain whitespace-pre-wrap break-words rounded-400 border border-border-primary px-3 py-2 font-mono text-sm leading-6 text-text-primary outline-none focus:border-border-theme-thick focus-visible:border-border-theme-thick'
        />
        {suggestions.length > 0 && (
          <div
            role='listbox'
            data-testid='formula-autocomplete'
            className='absolute left-0 top-full z-10 mt-1 max-h-60 w-64 overflow-y-auto overscroll-contain rounded-400 border border-border-primary bg-surface-primary p-1 shadow-md'
          >
            {suggestions.map((item, index) => (
              <button
                key={`${item.kind}:${item.label}`}
                type='button'
                role='option'
                aria-selected={index === active}
                aria-disabled={item.is_disabled}
                disabled={item.is_disabled}
                title={item.disabled_reason ?? undefined}
                data-testid={`formula-suggestion-${completionLabel(item, schema)}`}
                className={cn(
                  'flex h-8 w-full items-center gap-2 rounded-300 px-2 text-left text-sm disabled:opacity-50',
                  index === active ? 'bg-fill-content-hover' : 'hover:bg-fill-content-hover'
                )}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => accept(item)}
              >
                <span className={cn('truncate', item.kind !== 'Property' && 'font-mono')}>
                  {completionLabel(item, schema)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {help?.signature_help && <Signature help={help.signature_help} />}
      <div className='flex min-h-6 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs'>
        {error && (
          <span className='flex min-w-0 items-center gap-1 text-text-error' data-testid='formula-editor-error'>
            <WarningSvg className='h-4 w-4 shrink-0' />
            <span className='break-words'>{error}</span>
          </span>
        )}
        <Button
          variant='ghost'
          size='sm'
          disabled={!analysis}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void format()}
          data-testid='formula-editor-format'
        >
          Format
        </Button>
        {(analysis?.fixes ?? []).map((fix, index) => (
          <Button
            key={`${fix.title}:${index}`}
            variant='ghost'
            size='sm'
            data-testid='formula-editor-quick-fix'
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void applyNativeEdit(fix.edit)}
          >
            {fix.title}
          </Button>
        ))}
        <span
          className='ml-auto rounded-300 bg-fill-secondary px-2 py-0.5 text-text-secondary'
          data-testid='formula-editor-type'
        >
          {t('grid.formula.type', { defaultValue: 'Type' })}:{' '}
          {analysis ? typeToString(appFlowyFormulaType(analysis.state.output_type)) : '…'}
        </span>
      </div>
      {previewRows.length > 0 && (
        <div className='flex min-h-8 shrink-0 items-center gap-2 text-sm' data-testid='formula-editor-preview'>
          <span className='shrink-0 text-text-secondary'>
            {t('grid.formula.previewWith', { defaultValue: 'Preview with' })}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant='ghost' size='sm' className='max-w-[220px] gap-1 px-2' data-testid='formula-preview-row'>
                <span className='truncate'>{previewRow?.label}</span>
                <ArrowDownIcon className='h-4 w-4 shrink-0 text-icon-secondary' />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='start' className='max-h-72 w-[240px] overflow-y-auto'>
              {previewRows.map((row) => (
                <DropdownMenuItem key={row.id} onSelect={() => setPreviewRowId(row.id)}>
                  <span className='truncate'>{row.label}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <span
            className='min-w-0 flex-1 truncate font-mono text-text-primary'
            data-testid='formula-preview-value'
            data-evaluation-state={preview?.evaluationState ?? 'pending'}
          >
            {preview && !preview.error ? preview.text || (preview.evaluationState === 'null' ? '—' : '') : ''}
          </span>
        </div>
      )}
      <div className='grid min-h-[160px] flex-auto grid-cols-1 gap-3 overflow-y-auto border-t border-border-primary pt-3 md:grid-cols-[minmax(0,240px)_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)] md:overflow-hidden'>
        <FormulaCatalogue
          items={catalogue}
          schema={schema}
          search={search}
          onSearch={setSearch}
          onSelect={setSelected}
          onInsert={insert}
        />
        <FormulaDocsPanel item={documented} schema={schema} onInsert={(text) => insert(text)} />
      </div>
    </div>
  );
});

const FormulaCatalogue = memo(function FormulaCatalogue({
  items,
  schema,
  search,
  onSearch,
  onSelect,
  onInsert,
}: {
  items: CompletionItem[];
  schema: FormulaFieldSchema[];
  search: string;
  onSearch: (value: string) => void;
  onSelect: (item: FormulaDocsItem | null) => void;
  onInsert: (text: string, cursor: number) => void;
}) {
  const { t } = useTranslation();
  const sections = [
    {
      title: t('grid.formula.properties', { defaultValue: 'Properties' }),
      items: items.filter((item) => item.kind === 'Property'),
    },
    {
      title: t('grid.formula.builtins', { defaultValue: 'Built-ins' }),
      items: items.filter((item) => item.kind === 'Builtin' || item.kind === 'Operator'),
    },
    {
      title: t('grid.formula.functions', { defaultValue: 'Functions' }),
      items: items.filter((item) => item.kind.startsWith('Function')),
    },
  ];

  return (
    <div className='flex min-h-0 flex-col gap-1'>
      <SearchInput
        className='shrink-0'
        placeholder={t('search.label', { defaultValue: 'Search' })}
        value={search}
        onChange={(event) => onSearch(event.target.value)}
        data-testid='formula-catalogue-search'
      />
      <div
        className='appflowy-scroller max-h-[320px] min-h-0 flex-auto overflow-y-auto overscroll-contain pr-1'
        data-testid='formula-catalogue'
      >
        {sections.map(
          (section) =>
            section.items.length > 0 && (
              <div key={section.title} className='mb-2'>
                <div
                  className='px-2 py-1 text-xs font-medium text-text-tertiary'
                  data-testid='formula-catalogue-section'
                >
                  {section.title}
                </div>
                {section.items.map((item) => {
                  const property =
                    item.kind === 'Property' ? schema.find((entry) => entry.id === item.label) : undefined;
                  const name = item.label.replace(/\(\)$/, '');

                  return (
                    <button
                      key={`${item.kind}:${item.label}`}
                      type='button'
                      disabled={item.is_disabled}
                      title={item.disabled_reason ?? undefined}
                      data-testid={`formula-catalogue-${
                        property
                          ? `property-${property.id}`
                          : `${item.kind.startsWith('Function') ? 'function' : 'builtin'}-${name}`
                      }`}
                      className='flex h-8 w-full items-center gap-2 rounded-300 px-2 text-left text-sm text-text-primary hover:bg-fill-content-hover disabled:opacity-50'
                      onMouseEnter={() => onSelect(docsItem(item, schema))}
                      onFocus={() => onSelect(docsItem(item, schema))}
                      // Keep Slate's range while the catalogue triggers insertion.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        onSelect(docsItem(item, schema));
                        const text = item.insert_text;

                        // Catalogue edits start at zero on its private native empty Draft.
                        onInsert(text, item.cursor ?? text.length);
                      }}
                    >
                      {property && (
                        <FieldTypeIcon type={property.type} className='h-4 w-4 shrink-0 text-icon-secondary' />
                      )}
                      <span className={cn('truncate', !property && 'font-mono')}>{completionLabel(item, schema)}</span>
                    </button>
                  );
                })}
              </div>
            )
        )}
      </div>
    </div>
  );
});

export default FormulaEditor;
