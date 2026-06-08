"""Email sending for WebTerminal — uses the same local Postfix as vista_web.

Mirrors vista_web/utils/email_service.py: smtplib to SMTP_HOST:SMTP_PORT (localhost:25),
From noreply@vistawib.com. Postfix relays outbound via mail.vistawib.com.
"""
import logging
import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr

log = logging.getLogger("webterminal.email")

SMTP_HOST = os.environ.get("SMTP_HOST", "localhost")
SMTP_PORT = int(os.environ.get("SMTP_PORT", 25))
SMTP_FROM_EMAIL = os.environ.get("SMTP_FROM_EMAIL", "noreply@vistawib.com")
SMTP_FROM_NAME = os.environ.get("SMTP_FROM_NAME", "WebTerminal")


def send_email(to_email: str, subject: str, html_body: str) -> bool:
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = formataddr((SMTP_FROM_NAME, SMTP_FROM_EMAIL))
        msg["To"] = to_email
        import re

        text_body = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", html_body)).strip()
        msg.attach(MIMEText(text_body, "plain", "utf-8"))
        msg.attach(MIMEText(html_body, "html", "utf-8"))
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
            server.sendmail(SMTP_FROM_EMAIL, [to_email], msg.as_string())
        log.info("email sent to %s: %s", to_email, subject)
        return True
    except Exception as exc:  # noqa: BLE001
        log.warning("email send failed to %s: %s", to_email, exc)
        return False


def send_password_reset(to_email: str, reset_url: str, ttl_minutes: int) -> bool:
    subject = "WebTerminal — recuperación de contraseña"
    html = f"""
    <html><body style="font-family:Arial,sans-serif;color:#222;background:#0d0d1a;padding:24px;">
      <div style="max-width:520px;margin:0 auto;background:#1a1a2e;border:1px solid #2a2a45;
                  border-radius:12px;padding:28px;color:#c7c7e0;">
        <h2 style="color:#4fc3f7;margin-top:0;">Recuperar contraseña</h2>
        <p>Has solicitado restablecer la contraseña de tu acceso a <b>WebTerminal</b>.</p>
        <p>Pulsa el botón para elegir una nueva contraseña (el enlace caduca en {ttl_minutes} minutos):</p>
        <p style="text-align:center;margin:28px 0;">
          <a href="{reset_url}" style="background:#4fc3f7;color:#08131a;text-decoration:none;
             font-weight:bold;padding:12px 26px;border-radius:7px;display:inline-block;">
             Restablecer contraseña</a>
        </p>
        <p style="font-size:12px;color:#6c6c92;">Si no has sido tú, ignora este correo; tu contraseña no cambiará.</p>
        <p style="font-size:12px;color:#6c6c92;word-break:break-all;">Enlace: {reset_url}</p>
      </div>
    </body></html>
    """
    return send_email(to_email, subject, html)
