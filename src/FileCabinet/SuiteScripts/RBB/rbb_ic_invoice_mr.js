/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 *
 * RBB Intercompany Invoice – Map/Reduce Script
 *
 * Workflow:
 *  getInputData  – searches for unbilled, approved, billable Time Bills for the
 *                  specified project within the requested period.
 *  map           – re-emits each time bill keyed by projectId so all entries for
 *                  a project arrive at the same reducer.
 *  reduce        – groups time bills by employee class, looks up the hourly rate
 *                  from the project's rate card, creates one NetSuite Invoice with
 *                  one line per class, then marks each Time Bill as billed.
 *  summarize     – logs results / errors and sends an optional notification email.
 *
 * Script Parameters:
 *   custscript_rbb_mr_project_id   – Internal ID of the Job (project) record
 *   custscript_rbb_mr_period_start – Billing period start date (MM/DD/YYYY or localised)
 *   custscript_rbb_mr_period_end   – Billing period end date
 *   custscript_rbb_mr_invoice_date – Invoice date
 *   custscript_rbb_mr_due_date     – Invoice due date
 *   custscript_rbb_mr_tax_code     – Tax code internal ID (optional)
 *   custscript_rbb_mr_memo         – Invoice memo (optional)
 *   custscript_rbb_mr_notify_email – Email for completion notification (optional)
 */
define([
  'N/search',
  'N/record',
  'N/runtime',
  'N/log',
  'N/email',
  'N/format',
], (search, record, runtime, log, email, format) => {

  /* ═══════════════════════════════════════════════════════════════════════════
   * getInputData – return a Search; NetSuite streams results to the map stage
   * ═══════════════════════════════════════════════════════════════════════════ */

  const getInputData = () => {
    const script      = runtime.getCurrentScript();
    const projectId   = script.getParameter({ name: 'custscript_rbb_mr_project_id' });
    const periodStart = script.getParameter({ name: 'custscript_rbb_mr_period_start' });
    const periodEnd   = script.getParameter({ name: 'custscript_rbb_mr_period_end' });

    log.audit({
      title:   'getInputData',
      details: `project=${projectId}  period=${periodStart} → ${periodEnd}`,
    });

    if (!projectId) throw new Error('custscript_rbb_mr_project_id is required.');

    return search.create({
      type: search.Type.TIME_BILL,
      filters: [
        ['customer',                'anyof', projectId],   // Job IS the customer on time bills
        'AND', ['trandate',         'within',  periodStart, periodEnd],
        'AND', ['isbillable',       'is',      'T'],
        'AND', ['approvalstatus',   'anyof',   '2'],        // Approved
        'AND', ['custbody_rbb_ic_billed', 'is', 'F'],       // Not yet billed
      ],
      columns: [
        'internalid',
        'employee',
        'customer',   // the Job/project
        'trandate',
        'hours',
        'memo',
        // Get the employee's class (role) via a join
        search.createColumn({ name: 'class', join: 'employee' }),
      ],
    });
  };

  /* ═══════════════════════════════════════════════════════════════════════════
   * map – key = projectId, value = serialised time bill data
   * ═══════════════════════════════════════════════════════════════════════════ */

  const map = (context) => {
    const result  = JSON.parse(context.value);
    const vals    = result.values;

    // Employee class may be returned as an array or object depending on NS version
    const classArr = vals['class.employee'];
    const classId  = Array.isArray(classArr) ? (classArr[0] || {}).value : (classArr || {}).value || '';
    const classText = Array.isArray(classArr) ? (classArr[0] || {}).text : (classArr || {}).text || '(No Class)';

    const projectId = Array.isArray(vals.customer) ? vals.customer[0].value : vals.customer.value;

    context.write({
      key:   String(projectId),
      value: JSON.stringify({
        timebillId: result.id,
        employeeId: Array.isArray(vals.employee) ? vals.employee[0].value : vals.employee.value,
        classId,
        classText,
        hours:  parseFloat(vals.hours) || 0,
        date:   vals.trandate,
        memo:   vals.memo || '',
      }),
    });
  };

  /* ═══════════════════════════════════════════════════════════════════════════
   * reduce – one call per project; creates the intercompany invoice
   * ═══════════════════════════════════════════════════════════════════════════ */

  const reduce = (context) => {
    const script      = runtime.getCurrentScript();
    const projectId   = context.key;
    const entries     = context.values.map((v) => JSON.parse(v));

    const invoiceDateStr = script.getParameter({ name: 'custscript_rbb_mr_invoice_date' });
    const dueDateStr     = script.getParameter({ name: 'custscript_rbb_mr_due_date' });
    const taxCode        = script.getParameter({ name: 'custscript_rbb_mr_tax_code' });
    const memo           = script.getParameter({ name: 'custscript_rbb_mr_memo' }) || '';

    log.audit({ title: 'reduce – start', details: `project=${projectId}, entries=${entries.length}` });

    // ── Load project ──────────────────────────────────────────────────────────
    const proj       = record.load({ type: 'job', id: projectId });
    const customerId = proj.getValue('customer');
    const rateCardId = proj.getValue('custentity_rbb_rate_card');

    if (!rateCardId) {
      const msg = `Project ${projectId} has no rate card assigned. Skipping.`;
      log.error({ title: 'reduce – no rate card', details: msg });
      context.write({ key: projectId, value: JSON.stringify({ error: msg }) });
      return;
    }

    // ── Load rate card lines ──────────────────────────────────────────────────
    const rateCardLines = loadRateCardLines(rateCardId);
    if (!rateCardLines.length) {
      const msg = `Rate card ${rateCardId} has no lines. Skipping.`;
      log.error({ title: 'reduce – empty rate card', details: msg });
      context.write({ key: projectId, value: JSON.stringify({ error: msg }) });
      return;
    }

    // ── Group entries by employee class ───────────────────────────────────────
    const byClass = {};
    entries.forEach((e) => {
      const key = e.classId || '__NONE__';
      if (!byClass[key]) byClass[key] = { classId: e.classId, classText: e.classText, hours: 0, timebillIds: [] };
      byClass[key].hours += e.hours;
      byClass[key].timebillIds.push(e.timebillId);
    });

    // ── Create the intercompany invoice ───────────────────────────────────────
    const inv = record.create({ type: record.Type.INVOICE, isDynamic: true });
    inv.setValue({ fieldId: 'entity',  value: customerId });
    inv.setValue({ fieldId: 'trandate', value: format.parse({ value: invoiceDateStr, type: format.Type.DATE }) });
    inv.setValue({ fieldId: 'duedate',  value: format.parse({ value: dueDateStr,     type: format.Type.DATE }) });
    if (memo)    inv.setValue({ fieldId: 'memo',    value: memo });
    if (taxCode) inv.setValue({ fieldId: 'taxcode', value: parseInt(taxCode, 10) });

    const invoicedTimebillIds = [];
    let hasLines = false;

    Object.values(byClass).forEach(({ classId, classText, hours, timebillIds }) => {
      const line = rateCardLines.find((l) => l.classId === classId);
      if (!line) {
        log.error({
          title:   'reduce – no rate for class',
          details: `classId=${classId} (${classText}) not found in rate card ${rateCardId}. Hours skipped.`,
        });
        return;
      }

      inv.selectNewLine({ sublistId: 'item' });
      inv.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item',        value: line.serviceItemId });
      inv.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity',    value: roundHours(hours) });
      inv.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate',        value: line.hourlyRate });
      inv.setCurrentSublistValue({ sublistId: 'item', fieldId: 'description', value: `${classText} – ${proj.getValue('companyname')}` });
      inv.commitLine({ sublistId: 'item' });

      invoicedTimebillIds.push(...timebillIds);
      hasLines = true;
    });

    if (!hasLines) {
      const msg = 'No matching rate card lines found for any employee class. Invoice not created.';
      log.error({ title: 'reduce – no lines', details: msg });
      context.write({ key: projectId, value: JSON.stringify({ error: msg }) });
      return;
    }

    const invoiceId = inv.save();
    log.audit({ title: 'reduce – invoice created', details: `invoiceId=${invoiceId}, project=${projectId}` });

    // ── Mark time bills as billed ─────────────────────────────────────────────
    invoicedTimebillIds.forEach((tbId) => {
      try {
        record.submitFields({
          type:   record.Type.TIME_BILL,
          id:     tbId,
          values: { custbody_rbb_ic_billed: true },
        });
      } catch (e) {
        log.error({ title: `reduce – mark billed failed for tb ${tbId}`, details: e.message });
      }
    });

    context.write({
      key:   projectId,
      value: JSON.stringify({ invoiceId, billedEntries: invoicedTimebillIds.length }),
    });
  };

  /* ═══════════════════════════════════════════════════════════════════════════
   * summarize – log results and send notification email
   * ═══════════════════════════════════════════════════════════════════════════ */

  const summarize = (context) => {
    const script       = runtime.getCurrentScript();
    const notifyEmail  = script.getParameter({ name: 'custscript_rbb_mr_notify_email' });

    const results = [];
    const errors  = [];

    context.output.iterator().each((key, value) => {
      const val = JSON.parse(value);
      if (val.error) errors.push({ project: key, error: val.error });
      else           results.push({ project: key, ...val });
      return true;
    });

    context.errors.iterator().each((key, error) => {
      log.error({ title: `MR error – key ${key}`, details: error });
      errors.push({ project: key, error });
      return true;
    });

    log.audit({
      title:   'summarize – complete',
      details: `invoices=${results.length}, errors=${errors.length}`,
    });

    if (notifyEmail) {
      try {
        const lines = [
          `Intercompany invoice generation complete.`,
          '',
          `Invoices created: ${results.length}`,
          ...results.map((r) => `  • Project ${r.project} → Invoice ID ${r.invoiceId} (${r.billedEntries} entries)`),
        ];
        if (errors.length) {
          lines.push('', `Errors (${errors.length}):`);
          errors.forEach((e) => lines.push(`  ✗ Project ${e.project}: ${e.error}`));
        }
        email.send({
          author:     runtime.getCurrentUser().id,
          recipients: [notifyEmail],
          subject:    `IC Invoice Generation – ${results.length} invoice(s) created`,
          body:       lines.join('\n'),
        });
      } catch (e) {
        log.error({ title: 'summarize – email failed', details: e.message });
      }
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════════
   * HELPERS
   * ═══════════════════════════════════════════════════════════════════════════ */

  /**
   * Load all rate card lines for a given rate card.
   * Returns: [{ classId, serviceItemId, hourlyRate }]
   */
  const loadRateCardLines = (rateCardId) => {
    const lines = [];
    search.create({
      type: 'customrecord_rbb_rate_card_line',
      filters: [['custrecord_rbb_rcl_rate_card', 'anyof', rateCardId]],
      columns: [
        'custrecord_rbb_rcl_employee_class',
        'custrecord_rbb_rcl_service_item',
        'custrecord_rbb_rcl_hourly_rate',
      ],
    }).run().each((result) => {
      lines.push({
        classId:       result.getValue('custrecord_rbb_rcl_employee_class'),
        serviceItemId: result.getValue('custrecord_rbb_rcl_service_item'),
        hourlyRate:    parseFloat(result.getValue('custrecord_rbb_rcl_hourly_rate')) || 0,
      });
      return true;
    });
    return lines;
  };

  /** Round hours to 2 decimal places (quarter-hour granularity is typical). */
  const roundHours = (h) => Math.round(h * 100) / 100;

  return { getInputData, map, reduce, summarize };
});
