const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * Monitor Hub Centralized Email Service
 */
class EmailService {
    /**
     * Send a 6-digit OTP code for signup verification
     */
    async sendOTP(email, otp) {
        try {
            await resend.emails.send({
                from: `Monitor Hub <${process.env.EMAIL_FROM}>`,
                to: email,
                subject: 'Your Monitor Hub Verification Code',
                html: `
                    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
                        <h2 style="color: #2563eb; margin-bottom: 8px;">Welcome to Monitor Hub!</h2>
                        <p style="color: #475569; font-size: 16px;">Please use the following code to verify your email address:</p>
                        <div style="background: #f8fafc; padding: 24px; text-align: center; border-radius: 8px; margin: 24px 0; border: 1px solid #e2e8f0;">
                            <span style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #1e293b;">${otp}</span>
                        </div>
                        <p style="color: #94a3b8; font-size: 14px;">This code will expire in 10 minutes. If you didn't request this, you can safely ignore this email.</p>
                    </div>
                `
            });
            console.log(`[EmailService] OTP sent to ${email}`);
            return true;
        } catch (err) {
            console.error('[EmailService] Failed to send OTP:', err.message);
            return false;
        }
    }

    /**
     * Send a service-down or recovery alert
     */
    async sendAlert(email, payload) {
        const { target, newStatus, errorMessage, timestamp } = payload;
        const isDown = newStatus === 'down';
        const brandColor = isDown ? '#ef4444' : '#10b981';
        const bgColor = isDown ? '#fef2f2' : '#f0fdf4';
        const borderColor = isDown ? '#fecaca' : '#bbf7d0';
        
        const subject = `${isDown ? '🚨 ALERT' : '✅ RECOVERY'}: ${target} is ${newStatus.toUpperCase()}`;

        try {
            await resend.emails.send({
                from: `Monitor Hub Alerts <${process.env.EMAIL_FROM}>`,
                to: email,
                subject: subject,
                html: `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <style>
                            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #1f2937; margin: 0; padding: 0; }
                            .container { max-width: 600px; margin: 20px auto; padding: 0; border: 1px solid #e5e7eb; border-radius: 12px; overflow: hidden; }
                            .header { padding: 32px 24px; text-align: center; background-color: ${bgColor}; border-bottom: 1px solid ${borderColor}; }
                            .status-badge { display: inline-block; padding: 4px 12px; border-radius: 9999px; font-size: 14px; font-weight: 600; color: white; background-color: ${brandColor}; margin-bottom: 12px; }
                            .content { padding: 32px 24px; }
                            .detail-row { display: flex; margin-bottom: 12px; font-size: 15px; border-bottom: 1px solid #f3f4f6; padding-bottom: 12px; }
                            .detail-label { color: #6b7280; width: 100px; font-weight: 500; }
                            .detail-value { color: #111827; font-weight: 600; flex: 1; word-break: break-all; }
                            .error-box { margin-top: 24px; padding: 16px; background-color: #fff1f2; border-left: 4px solid #ef4444; border-radius: 4px; }
                            .footer { padding: 24px; text-align: center; background-color: #f9fafb; border-top: 1px solid #e5e7eb; color: #9ca3af; font-size: 13px; }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <div class="header">
                                <div class="status-badge">${isDown ? 'INCIDENT DETECTED' : 'SERVICE RECOVERED'}</div>
                                <h1 style="margin: 0; font-size: 24px; color: ${brandColor};">${isDown ? 'Service is Down' : 'Service is back up'}</h1>
                            </div>
                            <div class="content">
                                <div class="detail-row">
                                    <span class="detail-label">Monitor</span>
                                    <span class="detail-value">${target}</span>
                                </div>
                                <div class="detail-row">
                                    <span class="detail-label">Status</span>
                                    <span class="detail-value" style="color: ${brandColor}">${newStatus.toUpperCase()}</span>
                                </div>
                                <div class="detail-row" style="border: none;">
                                    <span class="detail-label">Time</span>
                                    <span class="detail-value">${timestamp}</span>
                                </div>
                                ${isDown && errorMessage ? `
                                <div class="error-box">
                                    <strong style="display: block; color: #991b1b; margin-bottom: 4px; font-size: 13px; text-transform: uppercase;">Error Details</strong>
                                    <span style="color: #b91c1c; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 14px;">${errorMessage}</span>
                                </div>` : ''}
                            </div>
                            <div class="footer">
                                <p style="margin: 0;">&copy; ${new Date().getFullYear()} Monitor Hub. All rights reserved.</p>
                                <p style="margin: 4px 0 0;">This is an automated alert from your monitoring dashboard.</p>
                            </div>
                        </div>
                    </body>
                    </html>
                `
            });
            console.log(`[EmailService] Alert sent to ${email} for ${target}`);
            return true;
        } catch (err) {
            console.error('[EmailService] Failed to send alert:', err.message);
            return false;
        }
    }
}

module.exports = new EmailService();
