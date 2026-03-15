/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 *
 * RBB Intercompany Invoice – Map/Reduce Script
 *
 * Rate lookup mirrors NetSuite's native time-based billing rule behaviour:
 *   1. Exact employee match on the rate card line
 *   2. Employee's Billing Class match (employee.billingclass)
 *   3. Default line (no employee, no class specified)
 *
 * The native Billing Rate Card is read directly from job.billingratecard.
 * Rate card lines are accessed via the 'billingratecardline' sublist on the
 * billingratecard record (verify field IDs in the SuiteScript Records Browser
 * if NetSuite version differences are encountered).
 *
 * Workflow:
 *  getInputData  – searches unbilled, approved, billable Time Bills in period
 *  map           – keys each time bill by projectId; captures employee + billing class
 *  reduce        – groups by billing class, applies rate card lookup, creates Invoice
 *  summarize     – logs results and sends optional notification email
 *
 * Script Parameters:
 *   custscript_rbb_mr_project_id   – Internal ID of the Job (project) record
 *   custscript_rbb_mr_period_start – Billing period start date
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
        ['customer',                  'anyof', projectId],  // Job IS the customer on time bills
        'AND', ['trandate',           'within', periodStart, periodEnd],
        'AND', ['isbillable',         'is',     'T'],
        'AND', ['approvalstatus',     'anyof',  '2'],        // Approved
        'AND', ['custbody_rbb_ic_billed', 'is', 'F'],        // Not yet billed via this process
      ],
      columns: [
        'internalid',
        'employee',
        'customer',  // the Job/project
        'trandate',
        'hours',
        'memo',
        // Billing Class is set on the employee record and used by NetSuite's
        // own time-based billing rules to match against the rate card.
        search.createColumn({ name: 'billingclass', join: 'employee' }),
      ],
    });
  };

  /* ═══════════════════════════════════════════════════════════════════════════
   * map – key = projectId, value = serialised time bill data
   * ═══════════════════════════════════════════════════════════════════════════ */

  const map = (context) => {
    const result = JSON.parse(context.value);
    const vals   = result.values;

    // billingclass is returned as an array from the employee join
    const bcArr          = vals['billingclass.employee'];
    const billingClassId = Array.isArray(bcArr) ? (bcArr[0] || {}).value : (bcArr || {}).value || '';
    const billingClassText = Array.isArray(bcArr) ? (bcArr[0] || {}).text : (bcArr || {}).text || '(No Billing Class)';

    const projectId  = Array.isArray(vals.customer) ? vals.customer[0].value : vals.customer.value;
    const employeeId = Array.isArray(vals.employee) ? vals.employee[0].value : vals.employee.value;

    context.write({
      key:   String(projectId),
      value: JSON.stringify({
        timebillId:      result.id,
        employeeId:      String(employeeId),
        billingClassId:  String(billingClassId),
        billingClassText,
        hours: parseFloat(vals.hours) || 0,
        date:  vals.trandate,
        memo:  vals.memo || '',
      }),
    });
  };

  /* ═══════════════════════════════════════════════════════════════════════════
   * reduce – one call per project; creates the intercompany invoice
   * ═══════════════════════════════════════════════════════════════════════════ */

  const reduce = (context) => {
    const script    = runtime.getCurrentScript();
    const projectId = context.key;
    const entries   = context.values.map((v) => JSON.parse(v));

    const invoiceDateStr = script.getParameter({ name: 'custscript_rbb_mr_invoice_date' });
    const dueDateStr     = script.getParameter({ name: 'custscript_rbb_mr_due_date' });
    const taxCode        = script.getParameter({ name: 'custscript_rbb_mr_tax_code' });
    const memo           = script.getParameter({ name: 'custscript_rbb_mr_memo' }) || '';

    log.audit({ title: 'reduce – start', details: `project=${projectId}, entries=${entries.length}` });

    // ── Load project ──────────────────────────────────────────────────────────
    const proj        = record.load({ type: 'job', id: projectId });
    const customerId  = proj.getValue('customer');
    const rateCardId  = proj.getValue('billingratecard'); // native Job field

    if (!rateCardId) {
      const msg = `Project ${projectId} has no Billing Rate Card assigned. Skipping.`;
      log.error({ title: 'reduce – no rate card', details: msg });
      context.write({ key: projectId, value: JSON.stringify({ error: msg }) });
      return;
    }

    // ── Load native billing rate card lines ───────────────────────────────────
    const rateCardLines = loadRateCardLines(rateCardId);
    if (!rateCardLines.length) {
      const msg = `Billing Rate Card ${rateCardId} has no lines. Skipping.`;
      log.error({ title: 'reduce – empty rate card', details: msg });
      context.write({ key: projectId, value: JSON.stringify({ error: msg }) });
      return;
    }

    // ── Group time bills by billing class (or by employee when class is absent) ─
    // Group key: 'class:{billingClassId}' or 'emp:{employeeId}'
    const groups = {};
    entries.forEach((e) => {
      const key = e.billingClassId ? `class:${e.billingClassId}` : `emp:${e.employeeId}`;
      if (!groups[key]) {
        groups[key] = {
          billingClassId:   e.billingClassId,
          billingClassText: e.billingClassText,
          employeeId:       e.employeeId,
          hours:            0,
          timebillIds:      [],
        };
      }
      groups[key].hours += e.hours;
      groups[key].timebillIds.push(e.timebillId);
    });

    // ── Create the intercompany invoice ───────────────────────────────────────
    const inv = record.create({ type: record.Type.INVOICE, isDynamic: true });
    inv.setValue({ fieldId: 'entity',   value: customerId });
    inv.setValue({ fieldId: 'trandate', value: format.parse({ value: invoiceDateStr, type: format.Type.DATE }) });
    inv.setValue({ fieldId: 'duedate',  value: format.parse({ value: dueDateStr,     type: format.Type.DATE }) });
    if (memo)    inv.setValue({ fieldId: 'memo',    value: memo });
    if (taxCode) inv.setValue({ fieldId: 'taxcode', value: parseInt(taxCode, 10) });

    const invoicedTimebillIds = [];
    let hasLines = false;

    Object.values(groups).forEach(({ billingClassId, billingClassText, employeeId, hours, timebillIds }) => {
      // Priority: employee match → billing class match → default
      const line = findRate(rateCardLines, employeeId, billingClassId);
      if (!line) {
        log.error({
          title:   'reduce – no rate found',
          details: `No rate card line matched: employee=${employeeId}, billingClass=${billingClassId} (${billingClassText}). Hours skipped.`,
        });
        return;
      }

      const lineLabel = billingClassText !== '(No Billing Class)'
        ? billingClassText
        : `Employee ${employeeId}`;

      inv.selectNewLine({ sublistId: 'item' });
      inv.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item',        value: line.serviceItemId });
      inv.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity',    value: roundHours(hours) });
      inv.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate',        value: line.hourlyRate });
      inv.setCurrentSublistValue({ sublistId: 'item', fieldId: 'description', value: `${lineLabel} – ${proj.getValue('companyname')}` });
      inv.commitLine({ sublistId: 'item' });

      invoicedTimebillIds.push(...timebillIds);
      hasLines = true;
    });

    if (!hasLines) {
      const msg = 'No rate card lines matched any billing class. Invoice not created.';
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
        log.error({ title: `reduce – mark billed failed tb ${tbId}`, details: e.message });
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
    const script      = runtime.getCurrentScript();
    const notifyEmail = script.getParameter({ name: 'custscript_rbb_mr_notify_email' });

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
          'Intercompany invoice generation complete.',
          '',
          `Invoices created: ${results.length}`,
          ...results.map((r) => `  • Project ${r.project} → Invoice ID ${r.invoiceId} (${r.billedEntries} time entries)`),
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
   * Load lines from the native NetSuite Billing Rate Card record.
   *
   * Sublist ID:  'billingratecardline'
   * Field IDs:   'employee', 'class', 'item', 'rate'
   *
   * If your NS version uses different field IDs, verify them in the
   * SuiteScript Records Browser (Help > SuiteScript Records Browser >
   * search 'billingratecard').
   *
   * Returns: [{ employeeId, billingClassId, serviceItemId, hourlyRate }]
   */
  const loadRateCardLines = (rateCardId) => {
    const lines = [];
    const rc = record.load({ type: 'billingratecard', id: rateCardId });
    const lineCount = rc.getLineCount({ sublistId: 'billingratecardline' });

    for (let i = 0; i < lineCount; i++) {
      const employeeId     = rc.getSublistValue({ sublistId: 'billingratecardline', fieldId: 'employee', line: i });
      const billingClassId = rc.getSublistValue({ sublistId: 'billingratecardline', fieldId: 'class',    line: i });
      const serviceItemId  = rc.getSublistValue({ sublistId: 'billingratecardline', fieldId: 'item',     line: i });
      const rate           = rc.getSublistValue({ sublistId: 'billingratecardline', fieldId: 'rate',     line: i });

      lines.push({
        employeeId:     employeeId     ? String(employeeId)     : null,
        billingClassId: billingClassId ? String(billingClassId) : null,
        serviceItemId,
        hourlyRate: parseFloat(rate) || 0,
      });
    }

    log.debug({ title: 'loadRateCardLines', details: `rateCard=${rateCardId}, lines=${lines.length}` });
    return lines;
  };

  /**
   * Find the best-matching rate card line for a given employee / billing class.
   * Mirrors NetSuite's native time-based billing rule priority:
   *   1. Exact employee match
   *   2. Employee billing class match (no employee specified on line)
   *   3. Default line (no employee, no class)
   */
  const findRate = (lines, employeeId, billingClassId) => (
    lines.find((l) => l.employeeId     && l.employeeId     === String(employeeId))     ||
    lines.find((l) => !l.employeeId    && l.billingClassId && l.billingClassId === String(billingClassId)) ||
    lines.find((l) => !l.employeeId    && !l.billingClassId) ||
    null
  );

  /** Round hours to 2 decimal places. */
  const roundHours = (h) => Math.round(h * 100) / 100;

  return { getInputData, map, reduce, summarize };
});
