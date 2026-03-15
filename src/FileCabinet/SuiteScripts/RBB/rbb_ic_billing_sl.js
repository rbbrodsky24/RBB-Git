/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * RBB Intercompany Project Billing – Suitelet
 *
 * Pages (driven by ?page= URL param):
 *   dashboard   – project overview with unbilled hours summary
 *   project     – create / edit a Job record linked to an intercompany customer + rate card
 *   timelog     – log a Time Bill against a project
 *   ratecard    – create / edit a custom Rate Card with per-role lines
 *   geninvoice  – generate intercompany invoice by submitting the Map/Reduce script
 */
define([
  'N/ui/serverWidget',
  'N/search',
  'N/record',
  'N/redirect',
  'N/task',
  'N/log',
  'N/runtime',
  'N/url',
  'N/format',
], (serverWidget, search, record, redirect, task, log, runtime, url, format) => {

  /* ═══════════════════════════════════════════════════════════════════════════
   * ENTRY POINT
   * ═══════════════════════════════════════════════════════════════════════════ */

  const onRequest = (context) => {
    const { request, response } = context;
    const page   = request.parameters.page || 'dashboard';
    const method = request.method;

    try {
      if (method === 'GET') {
        switch (page) {
          case 'project':    return renderProjectForm(context);
          case 'timelog':    return renderTimeLogForm(context);
          case 'ratecard':   return renderRateCardForm(context);
          case 'geninvoice': return renderGenerateInvoiceForm(context);
          default:           return renderDashboard(context);
        }
      } else {
        switch (page) {
          case 'project':    return handleProjectSave(context);
          case 'timelog':    return handleTimeLogSave(context);
          case 'ratecard':   return handleRateCardSave(context);
          case 'geninvoice': return handleGenerateInvoice(context);
          default:           return renderDashboard(context);
        }
      }
    } catch (e) {
      log.error({ title: 'Suitelet Error', details: JSON.stringify(e) });
      const errForm = serverWidget.createForm({ title: 'Error' });
      errForm.addField({
        id: 'err_html', type: serverWidget.FieldType.INLINEHTML, label: ' ',
      }).defaultValue = `<p style="color:red;font-weight:bold;padding:12px;">Error: ${e.message || e}</p>`;
      addNavButtons(errForm);
      response.writePage(errForm);
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════════
   * DASHBOARD
   * ═══════════════════════════════════════════════════════════════════════════ */

  const renderDashboard = ({ response }) => {
    const slUrl = getSuiteletUrl();
    const form = serverWidget.createForm({ title: 'Intercompany Project Billing' });

    form.addButton({ id: 'btn_new_project',  label: 'New Project',      functionName: `window.location='${slUrl}&page=project'` });
    form.addButton({ id: 'btn_log_time',     label: 'Log Time',         functionName: `window.location='${slUrl}&page=timelog'` });
    form.addButton({ id: 'btn_new_ratecard', label: 'New Rate Card',    functionName: `window.location='${slUrl}&page=ratecard'` });
    form.addButton({ id: 'btn_gen_invoice',  label: 'Generate Invoice', functionName: `window.location='${slUrl}&page=geninvoice'` });

    // ── Active Projects sublist ───────────────────────────────────────────────
    const sl = form.addSublist({
      id: 'sl_projects', type: serverWidget.SublistType.LIST, label: 'Active Projects',
    });
    sl.addColumn({ id: 'col_code',     type: serverWidget.FieldType.TEXT, label: 'Code' });
    sl.addColumn({ id: 'col_name',     type: serverWidget.FieldType.TEXT, label: 'Project Name' });
    sl.addColumn({ id: 'col_customer', type: serverWidget.FieldType.TEXT, label: 'Customer' });
    sl.addColumn({ id: 'col_rc',       type: serverWidget.FieldType.TEXT, label: 'Rate Card' });
    sl.addColumn({ id: 'col_status',   type: serverWidget.FieldType.TEXT, label: 'Status' });
    sl.addColumn({ id: 'col_unbilled', type: serverWidget.FieldType.TEXT, label: 'Unbilled Hrs' });

    const projectSearch = search.create({
      type: 'job',
      filters: [
        ['projectstatus', 'anyof', ['1', '2', '4']], // In Progress, Not Started, On Hold
        'AND', ['isinactive', 'is', 'F'],
      ],
      columns: ['entityid', 'companyname', 'customer', 'projectstatus', 'custentity_rbb_rate_card'],
    });

    let row = 0;
    projectSearch.run().each((result) => {
      const projId = result.id;
      sl.setSublistValue({ id: 'col_code',     line: row, value: result.getValue('entityid')                       || '' });
      sl.setSublistValue({ id: 'col_name',     line: row, value: result.getValue('companyname')                    || '' });
      sl.setSublistValue({ id: 'col_customer', line: row, value: result.getText('customer')                        || '' });
      sl.setSublistValue({ id: 'col_rc',       line: row, value: result.getText('custentity_rbb_rate_card')        || '—' });
      sl.setSublistValue({ id: 'col_status',   line: row, value: result.getText('projectstatus')                   || '' });
      sl.setSublistValue({ id: 'col_unbilled', line: row, value: String(getUnbilledHours(projId)) });
      row++;
      return row < 100;
    });

    response.writePage(form);
  };

  /* ═══════════════════════════════════════════════════════════════════════════
   * PROJECT SETUP
   * ═══════════════════════════════════════════════════════════════════════════ */

  const renderProjectForm = ({ request, response }) => {
    const projectId = request.parameters.id;
    const form = serverWidget.createForm({ title: projectId ? 'Edit Project' : 'New Intercompany Project' });
    form.clientScriptModulePath = './rbb_ic_billing_cs.js';
    addNavButtons(form);

    // ── Project Information ───────────────────────────────────────────────────
    form.addFieldGroup({ id: 'fg_info', label: 'Project Information' });

    const fCode = form.addField({ id: 'fld_code', type: serverWidget.FieldType.TEXT,    label: 'Project Code',  container: 'fg_info' });
    const fName = form.addField({ id: 'fld_name', type: serverWidget.FieldType.TEXT,    label: 'Project Name',  container: 'fg_info' });
    const fCust = form.addField({ id: 'fld_customer', type: serverWidget.FieldType.SELECT, label: 'Intercompany Customer', source: 'customer', container: 'fg_info' });
    fCode.isMandatory = true;
    fName.isMandatory = true;
    fCust.isMandatory = true;
    fCust.setHelpText({ help: 'Select the intercompany entity being billed (must be a different subsidiary).' });

    const fStatus = form.addField({ id: 'fld_status', type: serverWidget.FieldType.SELECT, label: 'Status', container: 'fg_info' });
    fStatus.addSelectOption({ value: '',  text: '-- Select --' });
    fStatus.addSelectOption({ value: '2', text: 'Not Started' });
    fStatus.addSelectOption({ value: '1', text: 'In Progress' });
    fStatus.addSelectOption({ value: '5', text: 'Completed' });
    fStatus.addSelectOption({ value: '4', text: 'On Hold' });
    fStatus.addSelectOption({ value: '3', text: 'Cancelled' });
    fStatus.isMandatory = true;
    fStatus.defaultValue = '1';

    // ── Billing ───────────────────────────────────────────────────────────────
    form.addFieldGroup({ id: 'fg_billing', label: 'Billing' });

    const fRC = form.addField({ id: 'fld_ratecard', type: serverWidget.FieldType.SELECT, label: 'Rate Card', source: 'customrecord_rbb_rate_card', container: 'fg_billing' });
    fRC.isMandatory = true;
    fRC.setHelpText({ help: 'Rate card that defines the hourly rate per employee class / role for this project.' });

    form.addField({ id: 'fld_budget_hours', type: serverWidget.FieldType.FLOAT, label: 'Budget Hours (optional)', container: 'fg_billing' });

    // ── Dates ─────────────────────────────────────────────────────────────────
    form.addFieldGroup({ id: 'fg_dates', label: 'Dates' });
    const fStart = form.addField({ id: 'fld_startdate', type: serverWidget.FieldType.DATE, label: 'Start Date', container: 'fg_dates' });
    fStart.isMandatory = true;
    form.addField({ id: 'fld_enddate',   type: serverWidget.FieldType.DATE, label: 'End Date (optional)', container: 'fg_dates' });

    form.addField({ id: 'fld_description', type: serverWidget.FieldType.TEXTAREA, label: 'Description' });

    // Hidden ID for edit mode
    const fId = form.addField({ id: 'fld_project_id', type: serverWidget.FieldType.INTEGER, label: 'Project ID' });
    fId.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });

    // Populate values for edit
    if (projectId) {
      const proj = record.load({ type: 'job', id: projectId });
      form.getField('fld_code').defaultValue         = proj.getValue('entityid')                    || '';
      form.getField('fld_name').defaultValue         = proj.getValue('companyname')                 || '';
      form.getField('fld_customer').defaultValue     = proj.getValue('customer');
      form.getField('fld_status').defaultValue       = proj.getValue('projectstatus');
      form.getField('fld_ratecard').defaultValue     = proj.getValue('custentity_rbb_rate_card');
      form.getField('fld_budget_hours').defaultValue = proj.getValue('estimatedtime');
      form.getField('fld_startdate').defaultValue    = proj.getValue('startdate');
      form.getField('fld_enddate').defaultValue      = proj.getValue('enddate');
      form.getField('fld_description').defaultValue  = proj.getValue('comments')                    || '';
      form.getField('fld_project_id').defaultValue   = projectId;
    }

    form.addSubmitButton({ label: projectId ? 'Save Changes' : 'Create Project' });
    response.writePage(form);
  };

  const handleProjectSave = ({ request }) => {
    const p = request.parameters;

    const values = {
      entityid:                 p.fld_code,
      companyname:              p.fld_name,
      customer:                 p.fld_customer,
      projectstatus:            p.fld_status,
      custentity_rbb_rate_card: p.fld_ratecard || null,
      estimatedtime:            p.fld_budget_hours ? parseFloat(p.fld_budget_hours) : null,
      startdate:                p.fld_startdate,
      enddate:                  p.fld_enddate  || null,
      comments:                 p.fld_description || '',
    };

    let savedId;
    if (p.fld_project_id) {
      record.submitFields({ type: 'job', id: p.fld_project_id, values });
      savedId = p.fld_project_id;
    } else {
      const proj = record.create({ type: 'job', isDynamic: false });
      Object.entries(values).forEach(([k, v]) => { if (v !== null && v !== '') proj.setValue({ fieldId: k, value: v }); });
      savedId = proj.save();
    }

    redirect.toSuitelet({
      scriptId:     runtime.getCurrentScript().id,
      deploymentId: runtime.getCurrentScript().deploymentId,
      parameters:   { page: 'timelog', project: savedId },
    });
  };

  /* ═══════════════════════════════════════════════════════════════════════════
   * TIME LOGGING
   * ═══════════════════════════════════════════════════════════════════════════ */

  const renderTimeLogForm = ({ request, response }) => {
    const preProject = request.parameters.project;
    const saved      = request.parameters.saved;

    const form = serverWidget.createForm({ title: 'Log Time – Intercompany Project' });
    form.clientScriptModulePath = './rbb_ic_billing_cs.js';
    addNavButtons(form);

    if (saved === 'true') {
      form.addField({ id: 'fld_msg', type: serverWidget.FieldType.INLINEHTML, label: ' ' })
        .defaultValue = '<div style="padding:8px 12px;background:#d4edda;color:#155724;border-radius:4px;margin-bottom:8px;">Time entry saved successfully.</div>';
    }

    form.addFieldGroup({ id: 'fg_entry', label: 'Time Entry' });

    const fProj = form.addField({ id: 'fld_project',  type: serverWidget.FieldType.SELECT, label: 'Project',  source: 'job',      container: 'fg_entry' });
    const fEmp  = form.addField({ id: 'fld_employee', type: serverWidget.FieldType.SELECT, label: 'Employee', source: 'employee', container: 'fg_entry' });
    const fDate = form.addField({ id: 'fld_date',     type: serverWidget.FieldType.DATE,   label: 'Date',                        container: 'fg_entry' });
    const fHrs  = form.addField({ id: 'fld_hours',    type: serverWidget.FieldType.FLOAT,  label: 'Hours',                       container: 'fg_entry' });
    fProj.isMandatory = true;
    fEmp.isMandatory  = true;
    fDate.isMandatory = true;
    fHrs.isMandatory  = true;
    fDate.defaultValue = format.format({ value: new Date(), type: format.Type.DATE });
    if (preProject) fProj.defaultValue = preProject;

    const fDesc = form.addField({ id: 'fld_description', type: serverWidget.FieldType.TEXTAREA, label: 'Description / Work Performed' });
    fDesc.isMandatory = true;

    const fBill = form.addField({ id: 'fld_billable', type: serverWidget.FieldType.CHECKBOX, label: 'Billable' });
    fBill.defaultValue = 'T';

    // Hidden flag read by submit button to distinguish "Save" vs "Save & Add Another"
    const fNext = form.addField({ id: 'fld_action', type: serverWidget.FieldType.TEXT, label: 'Action' });
    fNext.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
    fNext.defaultValue = 'save';

    form.addSubmitButton({ label: 'Save Time Entry' });
    form.addButton({
      id: 'btn_save_another', label: 'Save & Add Another',
      functionName: "document.querySelector('[name=fld_action]').value='add_another'; document.forms[0].submit();",
    });

    response.writePage(form);
  };

  const handleTimeLogSave = ({ request }) => {
    const p = request.parameters;

    const tb = record.create({ type: record.Type.TIME_BILL, isDynamic: true });
    tb.setValue({ fieldId: 'employee',      value: parseInt(p.fld_employee, 10) });
    tb.setValue({ fieldId: 'customer',      value: parseInt(p.fld_project, 10) });
    tb.setValue({ fieldId: 'trandate',      value: format.parse({ value: p.fld_date, type: format.Type.DATE }) });
    tb.setValue({ fieldId: 'hours',         value: parseFloat(p.fld_hours) });
    tb.setValue({ fieldId: 'memo',          value: p.fld_description || '' });
    tb.setValue({ fieldId: 'isbillable',    value: p.fld_billable === 'T' });
    tb.setValue({ fieldId: 'approvalstatus', value: 2 }); // Approved
    tb.save();

    const addAnother = (p.fld_action === 'add_another');
    redirect.toSuitelet({
      scriptId:     runtime.getCurrentScript().id,
      deploymentId: runtime.getCurrentScript().deploymentId,
      parameters: {
        page:    'timelog',
        project: addAnother ? p.fld_project : undefined,
        saved:   'true',
      },
    });
  };

  /* ═══════════════════════════════════════════════════════════════════════════
   * RATE CARD
   * ═══════════════════════════════════════════════════════════════════════════ */

  const renderRateCardForm = ({ request, response }) => {
    const rcId = request.parameters.id;
    const form = serverWidget.createForm({ title: rcId ? 'Edit Rate Card' : 'New Rate Card' });
    addNavButtons(form);

    form.addFieldGroup({ id: 'fg_header', label: 'Rate Card Details' });

    const fName = form.addField({ id: 'fld_name', type: serverWidget.FieldType.TEXT, label: 'Name', container: 'fg_header' });
    fName.isMandatory = true;

    form.addField({ id: 'fld_customer', type: serverWidget.FieldType.SELECT, label: 'Customer (optional)', source: 'customer', container: 'fg_header' })
      .setHelpText({ help: 'Leave blank to create a global / default rate card.' });

    const fCurr = form.addField({ id: 'fld_currency', type: serverWidget.FieldType.SELECT, label: 'Currency', container: 'fg_header' });
    ['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD'].forEach((c) => fCurr.addSelectOption({ value: c, text: c }));
    fCurr.isMandatory = true;
    fCurr.defaultValue = 'USD';

    const fEffFrom = form.addField({ id: 'fld_effective_from', type: serverWidget.FieldType.DATE, label: 'Effective From', container: 'fg_header' });
    fEffFrom.isMandatory = true;
    form.addField({ id: 'fld_effective_to', type: serverWidget.FieldType.DATE, label: 'Effective To (optional)', container: 'fg_header' });

    const fActive = form.addField({ id: 'fld_active', type: serverWidget.FieldType.CHECKBOX, label: 'Active', container: 'fg_header' });
    fActive.defaultValue = 'T';

    form.addField({ id: 'fld_notes', type: serverWidget.FieldType.TEXTAREA, label: 'Notes' });

    // ── Billing Rate Lines (one row per employee class / role) ────────────────
    const sl = form.addSublist({
      id: 'sl_lines', type: serverWidget.SublistType.INLINEEDITOR, label: 'Billing Rates by Role / Employee Class',
    });
    sl.addField({ id: 'line_class', label: 'Employee Class / Role', type: serverWidget.FieldType.SELECT,   source: 'classification' }).isMandatory = true;
    sl.addField({ id: 'line_item',  label: 'Service Item',          type: serverWidget.FieldType.SELECT,   source: 'serviceitem' }).isMandatory = true;
    sl.addField({ id: 'line_rate',  label: 'Hourly Rate',           type: serverWidget.FieldType.CURRENCY }).isMandatory = true;
    const fLineId = sl.addField({ id: 'line_id', label: 'Internal ID', type: serverWidget.FieldType.INTEGER });
    fLineId.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });

    // Hidden rc ID for edit mode
    const fRcId = form.addField({ id: 'fld_rc_id', type: serverWidget.FieldType.INTEGER, label: 'RC ID' });
    fRcId.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });

    // Populate for edit
    if (rcId) {
      const rc = record.load({ type: 'customrecord_rbb_rate_card', id: rcId });
      form.getField('fld_name').defaultValue          = rc.getValue('name')                             || '';
      form.getField('fld_customer').defaultValue      = rc.getValue('custrecord_rbb_rc_customer');
      form.getField('fld_currency').defaultValue      = rc.getValue('custrecord_rbb_rc_currency')       || 'USD';
      form.getField('fld_effective_from').defaultValue = rc.getValue('custrecord_rbb_rc_effective_from');
      form.getField('fld_effective_to').defaultValue  = rc.getValue('custrecord_rbb_rc_effective_to');
      form.getField('fld_active').defaultValue        = rc.getValue('custrecord_rbb_rc_is_active') ? 'T' : 'F';
      form.getField('fld_notes').defaultValue         = rc.getValue('custrecord_rbb_rc_notes')          || '';
      form.getField('fld_rc_id').defaultValue         = rcId;

      let lineRow = 0;
      search.create({
        type: 'customrecord_rbb_rate_card_line',
        filters: [['custrecord_rbb_rcl_rate_card', 'anyof', rcId]],
        columns: ['internalid', 'custrecord_rbb_rcl_employee_class', 'custrecord_rbb_rcl_service_item', 'custrecord_rbb_rcl_hourly_rate'],
      }).run().each((r) => {
        sl.setSublistValue({ id: 'line_id',    line: lineRow, value: r.getValue('internalid') });
        sl.setSublistValue({ id: 'line_class', line: lineRow, value: r.getValue('custrecord_rbb_rcl_employee_class') });
        sl.setSublistValue({ id: 'line_item',  line: lineRow, value: r.getValue('custrecord_rbb_rcl_service_item') });
        sl.setSublistValue({ id: 'line_rate',  line: lineRow, value: r.getValue('custrecord_rbb_rcl_hourly_rate') });
        lineRow++;
        return true;
      });
    }

    form.addSubmitButton({ label: rcId ? 'Save Rate Card' : 'Create Rate Card' });
    response.writePage(form);
  };

  const handleRateCardSave = ({ request }) => {
    const p     = request.parameters;
    const rcId  = p.fld_rc_id;

    const headerValues = {
      name:                          p.fld_name,
      custrecord_rbb_rc_customer:    p.fld_customer         || null,
      custrecord_rbb_rc_currency:    p.fld_currency,
      custrecord_rbb_rc_effective_from: p.fld_effective_from,
      custrecord_rbb_rc_effective_to:   p.fld_effective_to  || null,
      custrecord_rbb_rc_is_active:   p.fld_active === 'T',
      custrecord_rbb_rc_notes:       p.fld_notes            || '',
    };

    let savedRcId;
    if (rcId) {
      record.submitFields({ type: 'customrecord_rbb_rate_card', id: rcId, values: headerValues });
      savedRcId = rcId;
    } else {
      const rc = record.create({ type: 'customrecord_rbb_rate_card' });
      Object.entries(headerValues).forEach(([k, v]) => { if (v !== null) rc.setValue({ fieldId: k, value: v }); });
      savedRcId = rc.save();
    }

    // Save sublist lines
    const lineCount = request.getLineCount({ group: 'sl_lines' });
    for (let i = 0; i < lineCount; i++) {
      const lineId  = request.getSublistValue({ group: 'sl_lines', name: 'line_id',    line: i });
      const classId = request.getSublistValue({ group: 'sl_lines', name: 'line_class', line: i });
      const itemId  = request.getSublistValue({ group: 'sl_lines', name: 'line_item',  line: i });
      const rate    = request.getSublistValue({ group: 'sl_lines', name: 'line_rate',  line: i });

      if (!classId && !itemId) continue; // skip blank rows

      const lineValues = {
        custrecord_rbb_rcl_rate_card:      savedRcId,
        custrecord_rbb_rcl_employee_class: classId || null,
        custrecord_rbb_rcl_service_item:   itemId  || null,
        custrecord_rbb_rcl_hourly_rate:    parseFloat(rate) || 0,
      };

      if (lineId) {
        record.submitFields({ type: 'customrecord_rbb_rate_card_line', id: lineId, values: lineValues });
      } else {
        const ln = record.create({ type: 'customrecord_rbb_rate_card_line' });
        Object.entries(lineValues).forEach(([k, v]) => { if (v !== null) ln.setValue({ fieldId: k, value: v }); });
        ln.save();
      }
    }

    redirect.toSuitelet({
      scriptId:     runtime.getCurrentScript().id,
      deploymentId: runtime.getCurrentScript().deploymentId,
      parameters:   { page: 'ratecard', id: savedRcId },
    });
  };

  /* ═══════════════════════════════════════════════════════════════════════════
   * GENERATE INVOICE
   * ═══════════════════════════════════════════════════════════════════════════ */

  const renderGenerateInvoiceForm = ({ request, response }) => {
    const preProject = request.parameters.project;
    const taskId     = request.parameters.taskid;

    const form = serverWidget.createForm({ title: 'Generate Intercompany Invoice' });
    addNavButtons(form);

    // Show Map/Reduce status if we just submitted one
    if (taskId) {
      try {
        const mrStatus = task.checkStatus({ taskId });
        const isOk     = mrStatus.status === task.TaskStatus.COMPLETE;
        const isFail   = mrStatus.status === task.TaskStatus.FAILED;
        const bg  = isOk ? '#d4edda' : isFail ? '#f8d7da' : '#fff3cd';
        const col = isOk ? '#155724' : isFail ? '#721c24' : '#856404';
        const refresh = (!isOk && !isFail) ? ' — <a href="javascript:location.reload()">Refresh</a>' : '';
        form.addField({ id: 'fld_status_html', type: serverWidget.FieldType.INLINEHTML, label: ' ' })
          .defaultValue = `<div style="padding:10px 14px;background:${bg};color:${col};border-radius:4px;margin-bottom:10px;">
            Invoice generation: <strong>${mrStatus.status}</strong>${refresh}
          </div>`;
      } catch (e) { /* task may have expired from cache */ }
    }

    form.addFieldGroup({ id: 'fg_project', label: 'Project' });
    const fProj = form.addField({ id: 'fld_project', type: serverWidget.FieldType.SELECT, label: 'Project', source: 'job', container: 'fg_project' });
    fProj.isMandatory = true;
    if (preProject) fProj.defaultValue = preProject;

    form.addFieldGroup({ id: 'fg_period', label: 'Billing Period' });
    const fStart = form.addField({ id: 'fld_period_start', type: serverWidget.FieldType.DATE, label: 'Period Start', container: 'fg_period' });
    const fEnd   = form.addField({ id: 'fld_period_end',   type: serverWidget.FieldType.DATE, label: 'Period End',   container: 'fg_period' });
    fStart.isMandatory = true;
    fEnd.isMandatory   = true;

    form.addFieldGroup({ id: 'fg_inv', label: 'Invoice Details' });
    const fInvDate = form.addField({ id: 'fld_invoice_date', type: serverWidget.FieldType.DATE, label: 'Invoice Date', container: 'fg_inv' });
    const fDueDate = form.addField({ id: 'fld_due_date',     type: serverWidget.FieldType.DATE, label: 'Due Date',     container: 'fg_inv' });
    fInvDate.isMandatory = true;
    fDueDate.isMandatory = true;
    fInvDate.defaultValue = format.format({ value: new Date(), type: format.Type.DATE });

    form.addField({ id: 'fld_tax_code', type: serverWidget.FieldType.SELECT, label: 'Tax Code (optional)', source: 'taxtype', container: 'fg_inv' });
    form.addField({ id: 'fld_memo',     type: serverWidget.FieldType.TEXT,   label: 'Invoice Memo',         container: 'fg_inv' });

    form.addField({ id: 'fld_notify_email', type: serverWidget.FieldType.EMAIL, label: 'Notify Email (optional)' })
      .setHelpText({ help: 'Email address to notify when invoice generation is complete.' });

    form.addSubmitButton({ label: 'Generate Invoice' });
    response.writePage(form);
  };

  const handleGenerateInvoice = ({ request }) => {
    const p = request.parameters;

    if (!p.fld_project) throw new Error('Project is required.');

    const mrTask = task.create({
      taskType:     task.TaskType.MAP_REDUCE,
      scriptId:     'customscript_rbb_ic_invoice_mr',
      deploymentId: 'customdeploy_rbb_ic_invoice_mr',
      params: {
        custscript_rbb_mr_project_id:    p.fld_project,
        custscript_rbb_mr_period_start:  p.fld_period_start,
        custscript_rbb_mr_period_end:    p.fld_period_end,
        custscript_rbb_mr_invoice_date:  p.fld_invoice_date,
        custscript_rbb_mr_due_date:      p.fld_due_date,
        custscript_rbb_mr_tax_code:      p.fld_tax_code       || '',
        custscript_rbb_mr_memo:          p.fld_memo           || '',
        custscript_rbb_mr_notify_email:  p.fld_notify_email   || '',
      },
    });

    const taskId = mrTask.submit();
    log.audit({ title: 'MR task submitted', details: `taskId=${taskId}` });

    redirect.toSuitelet({
      scriptId:     runtime.getCurrentScript().id,
      deploymentId: runtime.getCurrentScript().deploymentId,
      parameters:   { page: 'geninvoice', taskid: taskId },
    });
  };

  /* ═══════════════════════════════════════════════════════════════════════════
   * HELPERS
   * ═══════════════════════════════════════════════════════════════════════════ */

  /** Return the current suitelet's URL (relative). */
  const getSuiteletUrl = () => url.resolveScript({
    scriptId:            runtime.getCurrentScript().id,
    deploymentId:        runtime.getCurrentScript().deploymentId,
    returnExternalUrl:   false,
  });

  /** Add standard navigation buttons to every form. */
  const addNavButtons = (form) => {
    const slUrl = getSuiteletUrl();
    form.addButton({ id: 'btn_nav_home',    label: '← Dashboard',    functionName: `window.location='${slUrl}'` });
    form.addButton({ id: 'btn_nav_proj',    label: 'Projects',        functionName: `window.location='${slUrl}&page=project'` });
    form.addButton({ id: 'btn_nav_time',    label: 'Log Time',        functionName: `window.location='${slUrl}&page=timelog'` });
    form.addButton({ id: 'btn_nav_rc',      label: 'Rate Cards',      functionName: `window.location='${slUrl}&page=ratecard'` });
    form.addButton({ id: 'btn_nav_invoice', label: 'Gen Invoice',     functionName: `window.location='${slUrl}&page=geninvoice'` });
  };

  /** Sum unbilled billable hours for a project. Returns string like "42.50". */
  const getUnbilledHours = (projectId) => {
    try {
      const results = search.create({
        type: 'timebill',
        filters: [
          ['customer', 'anyof', projectId],
          'AND', ['isbillable', 'is', 'T'],
          'AND', ['custbody_rbb_ic_billed', 'is', 'F'],
        ],
        columns: [search.createColumn({ name: 'hours', summary: search.Summary.SUM })],
      }).run().getRange({ start: 0, end: 1 });

      const val = results[0]
        ? parseFloat(results[0].getValue({ name: 'hours', summary: search.Summary.SUM })) || 0
        : 0;
      return val.toFixed(2);
    } catch (e) {
      return '—';
    }
  };

  return { onRequest };
});
