import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useDatabaseContext, useDatabaseFields } from '@/application/database-yjs/context';
import { useDeletePropertyDispatch } from '@/application/database-yjs/dispatch';
import { collectDependentFormulaFields } from '@/application/database-yjs/fields/formula/dependencies';
import {
  FormulaFieldSchema,
  formulaSchemaSignature,
  readFormulaSchema,
  readFormulaSchemaForVersion,
} from '@/application/database-yjs/fields/formula/schema';
import { useDatabaseFieldsVersion } from '@/application/database-yjs/hooks/useDatabaseFieldsVersion';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export function DeletePropertyConfirm({
  open,
  onClose,
  fieldId,
}: {
  open: boolean;
  onClose: () => void;
  fieldId: string;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(status) => {
        if (!status) onClose();
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {open && <DeletionContents fieldId={fieldId} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

/** Closed menus neither watch schema revisions nor own native Workers. */
function DeletionContents({ fieldId, onClose }: { fieldId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const context = useDatabaseContext();
  const fields = useDatabaseFields();
  const version = useDatabaseFieldsVersion();
  const schema = readFormulaSchemaForVersion(fields, version);
  const signature = formulaSchemaSignature(schema);
  const deleteDispatch = useDeletePropertyDispatch();
  const revision = useRef(0);
  const [snapshot, setSnapshot] = useState<{
    signature: string;
    fieldId: string;
    document: typeof context.databaseDoc;
    dependents: FormulaFieldSchema[];
    error?: string;
  }>();

  useEffect(() => {
    const currentRevision = ++revision.current;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && revision.current === currentRevision;

    void collectDependentFormulaFields(schema, fieldId, { signal: controller.signal })
      .then((dependents) => {
        if (current()) setSnapshot({ signature, fieldId, document: context.databaseDoc, dependents });
      })
      .catch((error: unknown) => {
        if (current())
          setSnapshot({
            signature,
            fieldId,
            document: context.databaseDoc,
            dependents: [],
            error: error instanceof Error ? error.message : 'Formula dependency check failed',
          });
      });
    return () => controller.abort();
  }, [schema, signature, fieldId, context.databaseDoc]);

  const ready =
    snapshot?.signature === signature && snapshot.fieldId === fieldId && snapshot.document === context.databaseDoc;
  const dependents = ready ? snapshot.dependents : [];
  const error = ready ? snapshot.error : undefined;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('grid.field.delete')}</DialogTitle>
      </DialogHeader>
      <DialogDescription>{t('grid.field.deleteFieldPromptMessage')}</DialogDescription>
      {!ready && (
        <p role='status' className='text-sm text-text-secondary' data-testid='formula-deletion-pending'>
          {t('grid.formula.checkingDependencies', { defaultValue: 'Checking formulas…' })}
        </p>
      )}
      {error && (
        <p role='alert' className='text-sm text-text-error' data-testid='formula-deletion-error'>
          {t('grid.formula.deleteDependencyCheckError', { defaultValue: 'Could not check formula dependencies.' })}{' '}
          {error}
        </p>
      )}
      {dependents.length > 0 && (
        <div role='alert' className='text-sm text-text-error' data-testid='formula-deletion-warning'>
          <p>
            {t('grid.formula.deleteDependencyWarning', {
              defaultValue: 'Deleting this property will break the following formulas:',
            })}
          </p>
          <ul className='appflowy-scroller mt-2 max-h-40 list-disc overflow-y-auto pl-5'>
            {dependents.map((entry) => (
              <li key={entry.id} className='break-words'>
                {entry.name || t('grid.formula.title', { defaultValue: 'Formula' })}
              </li>
            ))}
          </ul>
        </div>
      )}
      <DialogFooter>
        <Button variant='outline' onClick={onClose}>
          {t('button.cancel')}
        </Button>
        <Button
          variant='destructive'
          disabled={!ready}
          onClick={() => {
            // A collaborator can update Yjs before React reports its next revision.
            if (!ready || formulaSchemaSignature(readFormulaSchema(fields)) !== signature) return;
            deleteDispatch(fieldId);
            onClose();
          }}
        >
          {t('button.delete')}
        </Button>
      </DialogFooter>
    </>
  );
}

export default DeletePropertyConfirm;
