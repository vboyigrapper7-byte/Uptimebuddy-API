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
            const statusText = newStatus === 'warning' ? 'DEGRADED (Slow)' : (isDown ? 'DOWN' : 'RECOVERED');
            const emoji = newStatus === 'warning' ? '⚠️' : (isDown ? '🚨' : '✅');
            const timestamp = new Date().toLocaleString('en-US', { timeZone: 'UTC' }) + ' UTC';

            const message = `*${emoji} ${newStatus === 'warning' ? 'Service Degradation' : (isDown ? 'Server Down' : 'Server Recovered')}*\n` +
                          `🌐 *Monitor:* ${target}\n` +
                          `📊 *Status:* ${statusText}\n` +
                          `⏰ *Time:* ${timestamp}\n` +
                          (errorMessage ? `❌ *Error:* \`${errorMessage}\`` : '');

            let attempts = 0;
            while (attempts < 3) {
                try {
                    attempts++;
                    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                        chat_id: chatId,
                        text: message,
                        parse_mode: 'Markdown'
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
        if (!email) return;
        await emailService.sendAlert(email, payload);
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
        
        let color = '#10b981'; // green
        if (isDown) color = '#ef4444'; // red
        if (isWarning) color = '#f59e0b'; // orange

        return {
            text: `${isDown ? '🚨' : (isWarning ? '⚠️' : '✅')} *${isDown ? 'ALERT' : (isWarning ? 'DEGRADATION' : 'RECOVERY')}*`,
            attachments: [{
                color: color,
                fields: [
                    { title: 'Monitor',   value: target,       short: false },
                    { title: 'Transition', value: `${previousStatus.toUpperCase()} → ${newStatus.toUpperCase()}`, short: true },
                    { title: 'Time',       value: timestamp,   short: true },
                    ...(errorMessage ? [{ title: 'Error', value: errorMessage, short: false }] : []),
                ],
            }]
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
                color: color,
                fields: [
                    { name: 'Monitor',    value: target,       inline: false },
                    { name: 'Status',     value: `${previousStatus.toUpperCase()} → ${newStatus.toUpperCase()}`, inline: true },
                    { name: 'Time (UTC)', value: timestamp,    inline: true },
                    ...(errorMessage ? [{ name: 'Error', value: errorMessage, inline: false }] : []),
                ],
                footer: { text: 'Monitor Hub Monitoring' }
            }]
        };
    }
}

module.exports = new AlertService();
