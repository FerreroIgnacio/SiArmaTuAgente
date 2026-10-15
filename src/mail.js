import { env } from 'cloudflare:workers';

// Mails de las acciones: salen por Cloudflare Email Service (binding EMAIL) desde MAIL_FROM, con "responder a" el dueño.
// El dominio de MAIL_FROM tiene que estar habilitado: `npx wrangler email sending enable <dominio>`
//   adjuntos: [{ filename, content (ArrayBuffer), type }] (en total, hasta 5 MiB)
export async function enviarMail({ para, asunto, cuerpo, adjuntos = [], responderA }) {
  if (!env.EMAIL || !env.MAIL_FROM) throw new Error('El envío de mails no está configurado en el servidor');
  await env.EMAIL.send({
    from: env.MAIL_FROM,
    to: para.split(/[,;]/).map(s => s.trim()).filter(Boolean),
    replyTo: responderA || undefined,
    subject: asunto,
    text: cuerpo,
    attachments: adjuntos.map(a => ({ ...a, disposition: 'attachment' })),
  });
}
