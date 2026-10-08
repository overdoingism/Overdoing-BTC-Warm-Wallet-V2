// Modal dialogs built on <dialog>, plus turning errors into readable messages.
import { WalletError } from '../core/errors.js';
import { hasText, t } from '../i18n.js';
import { $, show } from './dom.js';

// Node / server rejections worth explaining in plain words.
const SERVER_MESSAGES = [
  [/insufficient fee|min relay fee not met|mempool min fee not met/i, 'srv.feeTooLow'],
  [/missingorspent|missing inputs|bad-txns-inputs/i, 'srv.spent'],
  [/txn-mempool-conflict|replacement/i, 'srv.conflict'],
  [/dust/i, 'srv.dust'],
  [/already in (block ?chain|mempool)|txn-already/i, 'srv.known'],
];

export function errorText(e) {
  if (e instanceof WalletError) {
    const params = { ...e.params };
    if (params.field && hasText(`field.${params.field}`)) params.field = t(`field.${params.field}`);
    const hit = typeof params.detail === 'string' ? SERVER_MESSAGES.find(([re]) => re.test(params.detail)) : null;
    return hit ? `${t(hit[1])}\n(${params.detail})` : t(e.key, params);
  }
  return String(e?.message ?? e);
}

/** Buttons with data-close="value" close their dialog with that return value. */
export function initDialogs() {
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-close]');
    if (b) b.closest('dialog').close(b.dataset.close);
  });
}

export function openDialog(dlg) {
  return new Promise((resolve) => {
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue), { once: true });
    dlg.showModal();
  });
}

export async function alertDialog(message, title = t('dlg.notice')) {
  $('alTitle').textContent = title;
  $('alMsg').textContent = message;
  await openDialog($('dlgAlert'));
}

export const alertError = (e) => alertDialog(errorText(e), t('dlg.error'));

/** rows: [label, value (text or Node), optional class for the value]. */
export function fillRows(dl, rows) {
  dl.replaceChildren();
  for (const [label, value, cls] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    if (value instanceof Node) dd.append(value);
    else dd.textContent = value;
    if (cls) dd.className = cls;
    dl.append(dt, dd);
  }
}

/** Resolves true only when the OK button was pressed. warnings: [{ text, danger? }]. */
export async function confirmDialog({ title, rows = [], warnings = [], ok = t('btn.ok') }) {
  $('cfTitle').textContent = title;
  fillRows($('cfRows'), rows);
  $('cfWarn').replaceChildren(
    ...warnings.map((w) => {
      const li = document.createElement('li');
      li.textContent = w.text;
      if (w.danger) li.className = 'danger';
      return li;
    }),
  );
  $('cfOk').textContent = ok;
  return (await openDialog($('dlgConfirm'))) === 'ok';
}

/** Resolves { password, name } or null when cancelled. */
export function passwordDialog({ title, intro = [], confirm = false, name = null, ack = false, minLength = 1 }) {
  const dlg = $('dlgPw');
  $('pwTitle').textContent = title;
  $('pwIntro').replaceChildren(...intro);
  show('pwNameRow', name !== null);
  $('pwName').value = name ?? '';
  show('pw2Row', confirm);
  show('pwAckRow', ack);
  $('pw1').value = '';
  $('pw2').value = '';
  $('pwAck').checked = false;
  $('pwErr').textContent = '';
  return new Promise((resolve) => {
    let result = null;
    const fail = (key, params) => {
      $('pwErr').textContent = t(key, params);
    };
    const submit = () => {
      const pw = $('pw1').value;
      if (pw.length < minLength) return fail(minLength > 1 ? 'pw.tooShort' : 'pw.empty', { n: minLength });
      if (confirm && pw !== $('pw2').value) return fail('pw.mismatch');
      if (ack && !$('pwAck').checked) return fail('pw.needAck');
      result = { password: pw, name: $('pwName').value };
      dlg.close('ok');
    };
    const onKey = (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
        e.preventDefault();
        submit();
      }
    };
    $('pwOk').onclick = submit;
    dlg.addEventListener('keydown', onKey);
    dlg.addEventListener(
      'close',
      () => {
        dlg.removeEventListener('keydown', onKey);
        $('pw1').value = '';
        $('pw2').value = '';
        resolve(result);
      },
      { once: true },
    );
    dlg.showModal();
    (name !== null ? $('pwName') : $('pw1')).focus();
  });
}

/** Runs fn(onProgress) behind a non-dismissable progress dialog. */
export async function withBusy(text, fn) {
  const dlg = $('dlgBusy');
  const bar = $('busyBar');
  $('busyText').textContent = text;
  bar.removeAttribute('value');
  const block = (e) => e.preventDefault();
  dlg.addEventListener('cancel', block);
  dlg.showModal();
  try {
    return await fn((p) => {
      bar.value = p;
    });
  } finally {
    dlg.removeEventListener('cancel', block);
    dlg.close();
  }
}

/** Wires a button to an async handler: disabled while running, errors shown in a dialog. */
export function action(id, fn, after) {
  const btn = $(id);
  btn.addEventListener('click', async () => {
    if (btn.dataset.running) return;
    btn.dataset.running = '1';
    btn.disabled = true;
    try {
      await fn();
    } catch (e) {
      await alertError(e);
    } finally {
      delete btn.dataset.running;
      btn.disabled = false;
      after?.();
    }
  });
}
