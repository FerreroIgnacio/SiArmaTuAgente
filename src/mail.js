import nodemailer from 'nodemailer';

// Mails de las acciones: salen desde una casilla de la plataforma (SMTP en .env), con "responder a" el dueño.
//   SMTP_HOST, SMTP_PORT (465 = TLS directo), SMTP_USER, SMTP_PASS, SMTP_FROM ("Si Agentes <avisos@…>")
let transporte = null;

function smtp() {
  if (transporte) return transporte;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST) throw new Error('El envío de mails no está configurado en el servidor (falta SMTP_HOST en .env)');
  const port = Number(SMTP_PORT) || 587;
  transporte = nodemailer.createTransport({
    host: SMTP_HOST, port, secure: port === 465,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
  return transporte;
}

export async function enviarMail({ para, asunto, cuerpo, responderA }) {
  await smtp().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: para,
    replyTo: responderA || undefined,
    subject: asunto,
    text: cuerpo,
  });
}
