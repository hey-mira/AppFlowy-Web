import { ElementType, KeyboardEvent, MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useDatabaseContext, useDatabaseFields } from '@/application/database-yjs/context';
import { FieldType } from '@/application/database-yjs/database.type';
import { useUpdateFormulaTypeOption } from '@/application/database-yjs/dispatch';
import { parseFormulaTypeOption } from '@/application/database-yjs/fields/formula/parse';
import { formulaSchemaSignature, readFormulaSchema } from '@/application/database-yjs/fields/formula/schema';
import { useDatabaseFieldsVersion } from '@/application/database-yjs/hooks/useDatabaseFieldsVersion';
import { useFieldSelector } from '@/application/database-yjs/selector';
import { YjsDatabaseKey } from '@/application/types';
import { ReactComponent as CloseIcon } from '@/assets/icons/close.svg';
import { Button } from '@/components/ui/button';

import { FormulaEditor, FormulaEditorHandle } from './FormulaEditor';

export interface FormulaEditorHostProps {
  /** Row the editor was opened from; used as the initial preview row. */
  rowId?: string;
  fieldId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Wiring every host of the formula editor (dialog or cell popover) puts on its
 * content element, plus the callback the panel reports its autocomplete with.
 */
export function useFormulaEditorHost() {
  // Radix handles Escape in the capture phase, before the formula input can
  // close its suggestion popup; keep the editor open while that popup shows.
  const autocompleteOpenRef = useRef(false);
  const onAutocompleteOpenChange = useCallback((open: boolean) => {
    autocompleteOpenRef.current = open;
  }, []);

  const contentProps = useMemo(
    () => ({
      // The editor renders inside a cell or menu; keep its clicks and keys
      // from reaching grid shortcuts and row handlers through the React tree.
      onClick: (event: MouseEvent) => event.stopPropagation(),
      onKeyDown: (event: KeyboardEvent) => event.stopPropagation(),
      onEscapeKeyDown: (event: globalThis.KeyboardEvent) => {
        const target = event.target;
        const fromFormulaInput =
          target instanceof Element && target.closest('[data-testid="formula-editor-input"]') !== null;

        // Only the formula input closes its suggestion list on Escape; from
        // anywhere else, Escape closes the editor.
        if (autocompleteOpenRef.current && fromFormulaInput) event.preventDefault();
      },
    }),
    []
  );

  return { contentProps, onAutocompleteOpenChange };
}

export interface FormulaEditorPanelProps {
  fieldId: string;
  /** Row the editor was opened from; used as the initial preview row. */
  rowId?: string;
  /** Closes the editor without saving; also called after a save. */
  onClose: () => void;
  onAutocompleteOpenChange: (open: boolean) => void;
  /** Title element; a dialog passes its title primitive so it labels the dialog. */
  titleAs?: ElementType;
  descriptionAs?: ElementType;
  titleId?: string;
  descriptionId?: string;
}

/**
 * The formula editor's content: header (title, Cancel, Done, close) and the
 * editor, holding the draft until it is saved. Hosts mount it only while
 * open, so each opening starts from the saved formula and a cancelled draft
 * is dropped with the component.
 */
export function FormulaEditorPanel({
  fieldId,
  rowId,
  onClose,
  onAutocompleteOpenChange,
  titleAs: Title = 'h2',
  descriptionAs: Description = 'p',
  titleId,
  descriptionId,
}: FormulaEditorPanelProps) {
  const { t } = useTranslation();
  const { field } = useFieldSelector(fieldId);
  const fields = useDatabaseFields();

  useDatabaseFieldsVersion();
  const context = useDatabaseContext();
  const updateFormulaTypeOption = useUpdateFormulaTypeOption(fieldId);
  const fieldName = String(field?.get(YjsDatabaseKey.name) ?? '');
  const [draft, setDraft] = useState(() => (field ? parseFormulaTypeOption(field).formula : ''));
  const [valid, setValid] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const editorRef = useRef<FormulaEditorHandle>(null);
  const mounted = useRef(true);
  const current = useRef({ draft, fields, context });

  current.current = { draft, fields, context };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const targetError = !field
    ? 'This property was deleted. Close the editor to continue.'
    : Number(field.get(YjsDatabaseKey.type)) !== FieldType.Formula
    ? 'This property is no longer a formula. Close the editor to continue.'
    : '';
  const editable = !context.readOnly && !context.dataSource && !targetError;

  // Formula text follows the existing policy: the latest local Done wins over
  // concurrent remote formula text. Other type options retain their live values.
  const handleSave = useCallback(async () => {
    if (!valid || saving || !editable || !editorRef.current) return;
    const before = current.current;

    setSaving(true);
    setSaveError('');
    try {
      while (mounted.current && current.current.context === before.context && current.current.draft === before.draft) {
        const freshSchema = readFormulaSchema(before.fields);
        const target = freshSchema.find((entry) => entry.id === fieldId);

        if (!target || target.type !== FieldType.Formula) return;
        const signature = formulaSchemaSignature(freshSchema);
        const definition = await editorRef.current.definition(freshSchema);

        if (!mounted.current || current.current.context !== before.context || current.current.draft !== before.draft)
          return;
        const latestSchema = readFormulaSchema(before.fields);

        if (formulaSchemaSignature(latestSchema) !== signature) continue;
        if (!definition) {
          setValid(false);
          setSaveError('The formula could not be saved. Check its current properties and diagnostics.');
          return;
        }

        // No asynchronous gap remains between the final schema check and Yjs.
        updateFormulaTypeOption({ formula: definition.expression });
        onClose();
        return;
      }
    } catch (error) {
      if (mounted.current) setSaveError(error instanceof Error ? error.message : 'Formula could not be saved');
    } finally {
      if (mounted.current) setSaving(false);
    }
  }, [valid, saving, editable, fieldId, updateFormulaTypeOption, onClose]);
  const changeDraft = useCallback((value: string) => {
    current.current.draft = value;
    setDraft(value);
    setValid(false);
    setSaveError('');
  }, []);

  return (
    <div className={'flex min-h-0 flex-1 flex-col gap-4'}>
      <div className={'flex shrink-0 items-center gap-3'}>
        {/* Only pass ids a host asks for: a dialog's title primitive supplies its own. */}
        <Title {...(titleId ? { id: titleId } : undefined)} className={'min-w-0 truncate text-base font-medium'}>
          {t('grid.formula.editFormula', { defaultValue: 'Edit formula' })}
          {fieldName ? <span className={'ml-2 text-text-secondary'}>· {fieldName}</span> : null}
        </Title>
        <Description {...(descriptionId ? { id: descriptionId } : undefined)} className={'sr-only'}>
          {t('grid.formula.dialogDescription', {
            defaultValue: 'Write a formula that computes this property from other properties.',
          })}
        </Description>
        <div className={'ml-auto flex shrink-0 items-center gap-2'}>
          <Button variant={'ghost'} size={'sm'} onClick={onClose} data-testid={'formula-editor-cancel'}>
            {t('button.cancel')}
          </Button>
          <Button
            size={'sm'}
            disabled={!valid || saving || !editable}
            onClick={() => void handleSave()}
            data-testid={'formula-editor-done'}
          >
            {t('button.done')}
          </Button>
          <Button
            variant={'ghost'}
            size={'icon'}
            aria-label={t('button.close', { defaultValue: 'Close' })}
            onClick={onClose}
            data-testid={'formula-editor-close'}
          >
            <CloseIcon aria-hidden={'true'} className={'h-5 w-5'} />
          </Button>
        </div>
      </div>
      {/* The editor keeps its formula rows in place and scrolls only the
          catalogue and docs; this scrolls only when even their minimum height
          does not fit. */}
      <div className={'appflowy-scroller flex min-h-0 flex-1 flex-col overflow-y-auto'}>
        <FormulaEditor
          ref={editorRef}
          fieldId={fieldId}
          value={draft}
          onChange={changeDraft}
          initialPreviewRowId={rowId}
          onSubmit={() => void handleSave()}
          onValidationChange={setValid}
          saveError={targetError || saveError}
          onAutocompleteOpenChange={onAutocompleteOpenChange}
        />
      </div>
    </div>
  );
}

export default FormulaEditorPanel;
