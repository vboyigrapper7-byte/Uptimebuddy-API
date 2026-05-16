/**
 * Monitor Hub Unified Alert Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Responsibilities:
 * - Localize and format messages for each provider.
 * - Dispatch alerts via HTTP with proper error handling.
 * - Centralize credentials and channel configuration.
 */
const axios = require('axios');
const emailService = require('../email/emailService');

class AlertService {
    constructor() {
        this.telegramToken = process.env.TELEGRAM_BOT_TOKEN;
        this.telegramChatId = process.env.TELEGRAM_CHAT_ID;
    }

    /**
     * Dispatch a status update to a specific Telegram channel.
     */
    async sendTelegram(payload, botToken, chatId) {
        const { target, newStatus, errorMessage } = payload;
        const isDown = newStatus === 'down';
        const emoji  = isDown ? '🚨' : '✅';
        const statusText = isDown ? 'DOWN' : 'RECOVERED';
        const timestamp  = new Date().toLocaleString('en-US', { timeZone: 'UTC' }) + ' UTC';

        if (!botToken || !chatId) return;

        try {
            const dashUrl = process.env.BACKEND_URL ? `[View Dashboard](${process.env.BACKEND_URL}/dashboard)` : '';
            const message = `*${emoji} ${newStatus === 'warning' ? 'Service Warning' : (isDown ? 'Monitor Down' : 'Monitor Recovered')}*\n` +
                          `🌐 *Monitor:* ${target}\n` +
                          `📊 *Status:* ${statusText}\n` +
                          `⏰ *Time:* ${timestamp}\n` +
                          (errorMessage ? `❌ *Error:* \`${errorMessage}\`\n` : '') +
                          `${dashUrl}`;

            let attempts = 0;
            while (attempts < 3) {
                try {
                    attempts++;
                    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                        chat_id: chatId,
                        text: message,
                        parse_mode: 'Markdown',
                        disable_web_page_preview: true
                    }, { timeout: 8000 });
                    console.log(`[AlertService] Telegram dispatch success for ${target} (Attempt ${attempts})`);
                    break;
                } catch (err) {
                    if (attempts >= 3) throw err;
                    await new Promise(r => setTimeout(r, 2000 * attempts));
                }
            }
        } catch (err) {
            console.error(`[AlertService] Telegram delivery failed: ${err.message}`);
        }
    }

    /**
     * Dispatch a status update to a specific Email address.
     */
    async sendEmail(payload, email) {
        if (!email) return false;
        return await emailService.sendAlert(email, payload);
    }

    /**
     * Dispatch a status update to system-wide channels.
     */
    async dispatch(payload) {
        // System-wide telegram from env
        if (this.telegramToken && this.telegramChatId) {
            await this.sendTelegram(payload, this.telegramToken, this.telegramChatId);
        }
        return true;
    }

    /**
     * Slack Formatter (legacy integration maintenance)
     */
    getSlackPayload(payload) {
        const { target, previousStatus, newStatus, errorMessage, timestamp } = payload;
        const isDown = newStatus === 'down';
        const isWarning = newStatus === 'warning';
        const statusEmoji = isDown ? '🚨' : (isWarning ? '⚠️' : '✅');
        const headerText = isDown ? 'CRITICAL: Monitor Down' : (isWarning ? 'WARNING: Performance Issue' : 'RECOVERY: Service Back Online');
        
        return {
            blocks: [
                {
                    type: "header",
                    text: { type: "plain_text", text: `${statusEmoji} ${headerText}` }
                },
                {
                    type: "section",
                    fields: [
                        { type: "mrkdwn", text: `*Monitor:*\n${target}` },
                        { type: "mrkdwn", text: `*Status:*\n${newStatus.toUpperCase()}` }
                    ]
                },
                ...(errorMessage ? [{
                    type: "section",
                    text: { type: "mrkdwn", text: `*Error Detail:*\n\`${errorMessage}\`` }
                }] : []),
                {
                    type: "context",
                    elements: [{ type: "mrkdwn", text: `*Time:* ${timestamp} UTC | *Monitor Hub*` }]
                },
                {
                    type: "actions",
                    elements: [{
                        type: "button",
                        text: { type: "plain_text", text: "View Dashboard" },
                        url: `${process.env.BACKEND_URL || 'https://monitorhubs.com'}/dashboard`
                    }]
                }
            ]
        };
    }

    /**
     * Discord Formatter (legacy integration maintenance)
     */
    getDiscordPayload(payload) {
        const { target, previousStatus, newStatus, errorMessage, timestamp } = payload;
        const isDown = newStatus === 'down';
        const isWarning = newStatus === 'warning';

        let color = 3447003; // green
        if (isDown) color = 15548997; // red
        if (isWarning) color = 16102656; // orange

        return {
            embeds: [{
                title: `${isDown ? '🚨 ALERT — Service Down' : (isWarning ? '⚠️ WARNING — Service Degraded' : '✅ RECOVERY — Service Restored')}`,
                description: `**Monitor:** ${target}\n**Status:** ${newStatus.toUpperCase()}\n**Time:** ${timestamp}`,
                color: color,
                fields: [
                    ...(errorMessage ? [{ name: 'Error Detail', value: `\`\`\`${errorMessage}\`\`\``, inline: false }] : []),
                ],
                footer: { text: 'Monitor Hub Real-time Telemetry' },
                timestamp: new Date().toISOString()
            }]
        };
    }
}

module.exports = new AlertService();
