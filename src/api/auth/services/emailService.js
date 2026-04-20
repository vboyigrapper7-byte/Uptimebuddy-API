/**
 * Auth Email Service
 * Handles sending OTPs using Resend with a professional HTML template.
 */

const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.EMAIL_FROM || 'noreply@monitorhubs.com';

/**
 * Send Signup OTP Email
 */
async function sendOTPEmail(email, otp) {
    try {
        const { data, error } = await resend.emails.send({
            from: `Monitor Hub <${FROM_EMAIL}>`,
            to: [email],
            subject: 'Verify your email - Monitor Hub',
            html: `
                <!DOCTYPE html>
                <html>
                <head>
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f7f9; }
                        .container { max-width: 600px; margin: 40px auto; padding: 20px; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
                        .header { text-align: center; padding-bottom: 20px; border-bottom: 1px solid #eee; }
                        .header h1 { color: #1a1a1a; margin: 0; font-size: 24px; font-weight: 700; }
                        .content { padding: 30px 20px; text-align: center; }
                        .otp-container { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin: 25px 0; }
                        .otp-code { font-size: 36px; font-weight: 800; letter-spacing: 4px; color: #2563eb; margin: 0; }
                        .expiry { color: #64748b; font-size: 14px; margin-top: 10px; }
                        .footer { text-align: center; font-size: 12px; color: #94a3b8; padding-top: 20px; border-top: 1px solid #eee; }
                        .brand { font-weight: 600; color: #334155; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="header">
                            <h1>Monitor Hub</h1>
                        </div>
                        <div class="content">
                            <p>Use the OTP below to verify your account and complete your signup.</p>
                            <div class="otp-container">
                                <h2 class="otp-code">${otp}</h2>
                            </div>
                            <p class="expiry">This code expires in <strong>5 minutes</strong>.</p>
                        </div>
                        <div class="footer">
                            <p>If you didn't request this, you can safely ignore this email.</p>
                            <p class="brand">Team Monitor Hub</p>
                        </div>
                    </div>
                </body>
                </html>
            `
        });

        if (error) {
            console.error('[Resend Error]:', error);
            return { success: false, error: error.message };
        }

        return { success: true, data };
    } catch (err) {
        console.error('[Email Service Error]:', err.message);
        return { success: false, error: err.message };
    }
}

module.exports = { sendOTPEmail };
