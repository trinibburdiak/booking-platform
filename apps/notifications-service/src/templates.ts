import { DateTime } from 'luxon';

export interface BookingEmailData {
  clientName: string;
  businessName: string;
  businessAddress: string | null;
  serviceName: string;
  professionalName: string;
  start: Date;
  timezone: string;
  cancellationHours: number;
  cancelUrl: string;
  businessUrl: string;
}

const when = (d: BookingEmailData) => {
  const s = DateTime.fromJSDate(d.start, { zone: d.timezone }).setLocale('es-AR').toFormat("cccc d 'de' LLLL 'a las' HH:mm 'h'");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function layout(title: string, body: string) {
  return `<!doctype html><html><body style="margin:0;background:#f5f5f4;font-family:Arial,sans-serif;color:#1c1917">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table width="100%" style="max-width:520px;background:#fff;border-radius:12px;padding:28px" cellpadding="0" cellspacing="0">
<tr><td><p style="margin:0 0 4px;color:#256449;font-weight:bold">turnos</p>
<h1 style="font-size:20px;margin:0 0 16px">${title}</h1>${body}</td></tr></table></td></tr></table></body></html>`;
}

function details(d: BookingEmailData) {
  return `<table cellpadding="4" style="font-size:14px;margin:12px 0 20px">
<tr><td style="color:#78716c">Cuándo</td><td><b>${esc(when(d))}</b></td></tr>
<tr><td style="color:#78716c">Servicio</td><td>${esc(d.serviceName)}</td></tr>
<tr><td style="color:#78716c">Con</td><td>${esc(d.professionalName)}</td></tr>
<tr><td style="color:#78716c">Dónde</td><td>${esc(d.businessName)}${d.businessAddress ? `, ${esc(d.businessAddress)}` : ''}</td></tr>
</table>`;
}

const button = (href: string, label: string, color = '#256449') =>
  `<a href="${esc(href)}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px">${label}</a>`;

const cancelNote = (d: BookingEmailData) =>
  `<p style="font-size:13px;color:#78716c;margin-top:20px">Podés cancelar hasta ${d.cancellationHours} h antes. ${button(d.cancelUrl, 'Cancelar turno', '#b91c1c')}</p>`;

export const confirmedEmail = (d: BookingEmailData) => ({
  subject: `Turno confirmado en ${d.businessName}`,
  html: layout(`¡Listo, ${esc(d.clientName)}! Tu turno está confirmado`, details(d) + cancelNote(d)),
});

export const rescheduledEmail = (d: BookingEmailData) => ({
  subject: `Cambió tu turno en ${d.businessName}`,
  html: layout('Tu turno fue reprogramado', `<p>El nuevo horario es:</p>${details(d)}${cancelNote(d)}`),
});

export const cancelledEmail = (d: BookingEmailData, byBusiness: boolean) => ({
  subject: `Turno cancelado en ${d.businessName}`,
  html: layout(
    'Tu turno fue cancelado',
    `<p>${byBusiness ? `${esc(d.businessName)} canceló este turno.` : 'Cancelaste este turno.'}</p>${details(d)}${button(d.businessUrl, 'Reservar otro turno')}`,
  ),
});

export const reminderEmail = (d: BookingEmailData) => ({
  subject: `Recordatorio: mañana tenés turno en ${d.businessName}`,
  html: layout(`Te esperamos, ${esc(d.clientName)}`, details(d) + cancelNote(d)),
});
