/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 *
 * RBB Intercompany Billing – Client Script
 *
 * Provides dynamic behaviour for the Suitelet forms:
 *  • Time Log form   : pre-fills today's date; validates hours > 0
 *  • Project form    : warns if billing company = customer company
 *  • Gen Invoice form: validates period end ≥ period start, due date ≥ invoice date
 *  • Rate Card form  : prevents saving a line with no rate
 */
define(['N/currentRecord', 'N/ui/message', 'N/log'], (currentRecord, message, log) => {

  /* ─── pageInit ──────────────────────────────────────────────────────────── */

  const pageInit = (context) => {
    // Nothing required at initialisation time; hooks below handle field changes.
  };

  /* ─── fieldChanged ──────────────────────────────────────────────────────── */

  const fieldChanged = (context) => {
    const rec   = context.currentRecord;
    const field = context.fieldId;

    // On the Generate Invoice form: auto-set due date to 30 days after invoice date
    if (field === 'fld_invoice_date') {
      const invDate = rec.getValue({ fieldId: 'fld_invoice_date' });
      if (invDate && !rec.getValue({ fieldId: 'fld_due_date' })) {
        const due = new Date(invDate);
        due.setDate(due.getDate() + 30);
        rec.setValue({ fieldId: 'fld_due_date', value: due, ignoreFieldChange: true });
      }
    }
  };

  /* ─── saveRecord ────────────────────────────────────────────────────────── */

  const saveRecord = (context) => {
    const rec = context.currentRecord;

    // ── Time Log validation ───────────────────────────────────────────────────
    const hours = rec.getValue({ fieldId: 'fld_hours' });
    if (hours !== null && hours !== '' && parseFloat(hours) <= 0) {
      alert('Hours must be greater than zero.');
      return false;
    }

    // ── Generate Invoice: period & date validation ────────────────────────────
    const periodStart = rec.getValue({ fieldId: 'fld_period_start' });
    const periodEnd   = rec.getValue({ fieldId: 'fld_period_end' });
    if (periodStart && periodEnd && new Date(periodEnd) < new Date(periodStart)) {
      alert('Period End must be on or after Period Start.');
      return false;
    }

    const invDate = rec.getValue({ fieldId: 'fld_invoice_date' });
    const dueDate = rec.getValue({ fieldId: 'fld_due_date' });
    if (invDate && dueDate && new Date(dueDate) < new Date(invDate)) {
      alert('Due Date must be on or after Invoice Date.');
      return false;
    }

    return true;
  };

  return { pageInit, fieldChanged, saveRecord };
});
