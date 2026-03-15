/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * RBB Intercompany Project Billing – Suitelet
 *
 * Pages (driven by ?page= URL param):
 *   dashboard   – project overview with unbilled hours summary
 *   project     – create / edit a Job record linked to an intercompany customer
 *                 and NetSuite's native Billing Rate Card (job.billingratecard)
 *   timelog     – log a Time Bill against a project
 *   geninvoice  – generate intercompany invoice by submitting the Map/Reduce script
 *
 * Rate cards are managed natively in NetSuite (Lists > Projects > Billing Rate Cards).
 * The Map/Reduce script uses the employee's Billing Class to match against rate card
 * lines, mirroring how NetSuite's own time-based billing rules work.
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
          case 'geninvoice': return renderGenerateInvoiceForm(context);
          default:           return renderDashboard(context);
        }
      } else {
        switch (page) {
          case 'project':    return handleProjectSave(context);
          case 'timelog':    return handleTimeLogSave(context);
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

    form.addButton({ id: 'btn_new_project', label: 'New Project',      functionName: `window.location='${slUrl}&page=project'` });
    form.addButton({ id: 'btn_log_time',    label: 'Log Time',         functionName: `window.location='${slUrl}&page=timelog'` });
    form.addButton({ id: 'btn_gen_invoice', label: 'Generate Invoice', functionName: `window.location='${slUrl}&page=geninvoice'` });

    // ── Active Projects sublist ───────────────────────────────────────────────
    const sl = form.addSublist({
      id: 'sl_projects', type: serverWidget.SublistType.LIST, label: 'Active Projects',
    });
    sl.addColumn({ id: 'col_code',     type: serverWidget.FieldType.TEXT, label: 'Code' });
    sl.addColumn({ id: 'col_name',     type: serverWidget.FieldType.TEXT, label: 'Project Name' });
    sl.addColumn({ id: 'col_customer', type: serverWidget.FieldType.TEXT, label: 'Customer' });
    sl.addColumn({ id: 'col_rc',       type: serverWidget.FieldType.TEXT, label: 'Billing Rate Card' });
    sl.addColumn({ id: 'col_status',   type: serverWidget.FieldType.TEXT, label: 'Status' });
    sl.addColumn({ id: 'col_unbilled', type: serverWidget.FieldType.TEXT, label: 'Unbilled Hrs' });

    const projectSearch = search.create({
      type: 'job',
      filters: [
        ['projectstatus', 'anyof', ['1', '2', '4']], // In Progress, Not Started, On Hold
        'AND', ['isinactive', 'is', 'F'],
      ],
      columns: ['entityid', 'companyname', 'customer', 'projectstatus', 'billingratecard'],
    });

    let row = 0;
    projectSearch.run().each((result) => {
      const projId = result.id;
      sl.setSublistValue({ id: 'col_code',     line: row, value: result.getValue('entityid')       || '' });
      sl.setSublistValue({ id: 'col_name',     line: row, value: result.getValue('companyname')    || '' });
      sl.setSublistValue({ id: 'col_customer', line: row, value: result.getText('customer')        || '' });
      sl.setSublistValue({ id: 'col_rc',       line: row, value: result.getText('billingratecard') || '—' });
      sl.setSublistValue({ id: 'col_status',   line: row, value: result.getText('projectstatus')   || '' });
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

    const fCode = form.addField({ id: 'fld_code', type: serverWidget.FieldType.TEXT,    label: 'Project Code',         container: 'fg_info' });
    const fName = form.addField({ id: 'fld_name', type: serverWidget.FieldType.TEXT,    label: 'Project Name',         container: 'fg_info' });
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

    // Populate the native Billing Rate Card dropdown from the billingratecard record type.
    // Rate cards are administered at Lists > Projects > Billing Rate Cards.
    const fRC = form.addField({
      id: 'fld_ratecard', type: serverWidget.FieldType.SELECT, label: 'Billing Rate Card', container: 'fg_billing',
    });
    fRC.isMandatory = true;
    fRC.setHelpText({ help: 'NetSuite Billing Rate Card that defines the hourly rate per employee Billing Class for this project. Managed at Lists > Projects > Billing Rate Cards.' });
    fRC.addSelectOption({ value: '', text: '-- Select Rate Card --' });
    search.create({ type: 'billingratecard', columns: ['name'] }).run().each((r) => {
      fRC.addSelectOption({ value: r.id, text: r.getValue('name') || `Rate Card ${r.id}` });
      return true;
    });

    form.addField({
      id: 'fld_budget_hours', type: serverWidget.FieldType.FLOAT, label: 'Budget Hours (optional)', container: 'fg_billing',
    });

    // ── Dates ─────────────────────────────────────────────────────────────────
    form.addFieldGroup({ id: 'fg_dates', label: 'Dates' });
    const fStart = form.addField({ id: 'fld_startdate', type: serverWidget.FieldType.DATE, label: 'Start Date',          container: 'fg_dates' });
    fStart.isMandatory = true;
    form.addField({ id: 'fld_enddate', type: serverWidget.FieldType.DATE, label: 'End Date (optional)', container: 'fg_dates' });

    form.addField({ id: 'fld_description', type: serverWidget.FieldType.TEXTAREA, label: 'Description' });

    // Hidden ID for edit mode
    const fId = form.addField({ id: 'fld_project_id', type: serverWidget.FieldType.INTEGER, label: 'Project ID' });
    fId.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });

    // Populate values for edit
    if (projectId) {
      const proj = record.load({ type: 'job', id: projectId });
      form.getField('fld_code').defaultValue         = proj.getValue('entityid')        || '';
      form.getField('fld_name').defaultValue         = proj.getValue('companyname')     || '';
      form.getField('fld_customer').defaultValue     = proj.getValue('customer');
      form.getField('fld_status').defaultValue       = proj.getValue('projectstatus');
      form.getField('fld_ratecard').defaultValue     = proj.getValue('billingratecard'); // native field
      form.getField('fld_budget_hours').defaultValue = proj.getValue('estimatedtime');
      form.getField('fld_startdate').defaultValue    = proj.getValue('startdate');
      form.getField('fld_enddate').defaultValue      = proj.getValue('enddate');
      form.getField('fld_description').defaultValue  = proj.getValue('comments')        || '';
      form.getField('fld_project_id').defaultValue   = projectId;
    }

    form.addSubmitButton({ label: projectId ? 'Save Changes' : 'Create Project' });
    response.writePage(form);
  };

  const handleProjectSave = ({ request }) => {
    const p = request.parameters;

    const values = {
      entityid:       p.fld_code,
      companyname:    p.fld_name,
      customer:       p.fld_customer,
      projectstatus:  p.fld_status,
      billingratecard: p.fld_ratecard || null, // native Job field
      estimatedtime:  p.fld_budget_hours ? parseFloat(p.fld_budget_hours) : null,
      startdate:      p.fld_startdate,
      enddate:        p.fld_enddate  || null,
      comments:       p.fld_description || '',
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
    tb.setValue({ fieldId: 'employee',       value: parseInt(p.fld_employee, 10) });
    tb.setValue({ fieldId: 'customer',       value: parseInt(p.fld_project, 10) });
    tb.setValue({ fieldId: 'trandate',       value: format.parse({ value: p.fld_date, type: format.Type.DATE }) });
    tb.setValue({ fieldId: 'hours',          value: parseFloat(p.fld_hours) });
    tb.setValue({ fieldId: 'memo',           value: p.fld_description || '' });
    tb.setValue({ fieldId: 'isbillable',     value: p.fld_billable === 'T' });
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
   * GENERATE INVOICE
   * ═══════════════════════════════════════════════════════════════════════════ */

  const renderGenerateInvoiceForm = ({ request, response }) => {
    const preProject = request.parameters.project;
    const taskId     = request.parameters.taskid;

    const form = serverWidget.createForm({ title: 'Generate Intercompany Invoice' });
    addNavButtons(form);

    if (taskId) {
      try {
        const mrStatus = task.checkStatus({ taskId });
        const isOk   = mrStatus.status === task.TaskStatus.COMPLETE;
        const isFail = mrStatus.status === task.TaskStatus.FAILED;
        const bg  = isOk ? '#d4edda' : isFail ? '#f8d7da' : '#fff3cd';
        const col = isOk ? '#155724' : isFail ? '#721c24' : '#856404';
        const refresh = (!isOk && !isFail) ? ' — <a href="javascript:location.reload()">Refresh</a>' : '';
        form.addField({ id: 'fld_status_html', type: serverWidget.FieldType.INLINEHTML, label: ' ' })
          .defaultValue = `<div style="padding:10px 14px;background:${bg};color:${col};border-radius:4px;margin-bottom:10px;">
            Invoice generation: <strong>${mrStatus.status}</strong>${refresh}
          </div>`;
      } catch (e) { /* task status may have expired */ }
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

    form.addField({ id: 'fld_tax_code', type: serverWidget.FieldType.SELECT, label: 'Tax Code (optional)', source: 'taxtype',  container: 'fg_inv' });
    form.addField({ id: 'fld_memo',     type: serverWidget.FieldType.TEXT,   label: 'Invoice Memo',         container: 'fg_inv' });

    form.addField({ id: 'fld_notify_email', type: serverWidget.FieldType.EMAIL, label: 'Notify Email (optional)' })
      .setHelpText({ help: 'Email address to notify when invoice generation completes.' });

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
        custscript_rbb_mr_project_id:   p.fld_project,
        custscript_rbb_mr_period_start: p.fld_period_start,
        custscript_rbb_mr_period_end:   p.fld_period_end,
        custscript_rbb_mr_invoice_date: p.fld_invoice_date,
        custscript_rbb_mr_due_date:     p.fld_due_date,
        custscript_rbb_mr_tax_code:     p.fld_tax_code      || '',
        custscript_rbb_mr_memo:         p.fld_memo          || '',
        custscript_rbb_mr_notify_email: p.fld_notify_email  || '',
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

  const getSuiteletUrl = () => url.resolveScript({
    scriptId:          runtime.getCurrentScript().id,
    deploymentId:      runtime.getCurrentScript().deploymentId,
    returnExternalUrl: false,
  });

  const addNavButtons = (form) => {
    const slUrl = getSuiteletUrl();
    form.addButton({ id: 'btn_nav_home',    label: '← Dashboard', functionName: `window.location='${slUrl}'` });
    form.addButton({ id: 'btn_nav_proj',    label: 'Projects',     functionName: `window.location='${slUrl}&page=project'` });
    form.addButton({ id: 'btn_nav_time',    label: 'Log Time',     functionName: `window.location='${slUrl}&page=timelog'` });
    form.addButton({ id: 'btn_nav_invoice', label: 'Gen Invoice',  functionName: `window.location='${slUrl}&page=geninvoice'` });
  };

  const getUnbilledHours = (projectId) => {
    try {
      const results = search.create({
        type: 'timebill',
        filters: [
          ['customer', 'anyof', projectId],
          'AND', ['isbillable',           'is', 'T'],
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
