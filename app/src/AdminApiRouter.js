'use strict';

/**
 * CineMeet Admin API Router
 * -------------------------
 * Secure REST API for the cineworm.org admin panel to manage CineMeet settings.
 *
 * All routes are protected by the x-admin-token header.
 * Token must match ADMIN_API_TOKEN in .env
 *
 * Endpoints:
 *   GET  /admin-api/status        - Server status, uptime, rooms info
 *   GET  /admin-api/settings      - All current .env settings
 *   POST /admin-api/settings      - Update .env settings + restart
 *   POST /admin-api/restart       - Restart CineMeet via PM2
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// Path to .env file (relative to this file: app/src/.env is at root)
const ENV_FILE_PATH = path.resolve(__dirname, '../../.env');

// ─── Auth Middleware ─────────────────────────────────────────────────────────

function requireAdminToken(req, res, next) {
    const token = req.headers['x-admin-token'];
    const expectedToken = process.env.ADMIN_API_TOKEN;

    if (!expectedToken) {
        return res.status(503).json({ error: 'Admin API not configured. Set ADMIN_API_TOKEN in .env' });
    }

    if (!token || token !== expectedToken) {
        return res.status(401).json({ error: 'Unauthorized. Invalid or missing admin token.' });
    }

    next();
}

// Apply auth to all routes
router.use(requireAdminToken);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Read and parse the .env file into a key/value object
 */
function readEnvFile() {
    if (!fs.existsSync(ENV_FILE_PATH)) return {};
    const content = fs.readFileSync(ENV_FILE_PATH, 'utf8');
    const result = {};
    content.split('\n').forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) return;
        const key = trimmed.substring(0, eqIdx).trim();
        let value = trimmed.substring(eqIdx + 1).trim();
        // Strip inline comments
        const commentIdx = value.indexOf(' #');
        const comment = commentIdx !== -1 ? value.substring(commentIdx) : '';
        if (commentIdx !== -1) value = value.substring(0, commentIdx).trim();
        result[key] = { value, comment };
    });
    return result;
}

/**
 * Write updated key/value pairs to the .env file, preserving comments and order
 */
function writeEnvFile(updates) {
    if (!fs.existsSync(ENV_FILE_PATH)) {
        return { success: false, error: '.env file not found' };
    }
    const content = fs.readFileSync(ENV_FILE_PATH, 'utf8');
    const lines = content.split('\n');
    const updatedKeys = new Set();

    const newLines = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) return line;
        const key = trimmed.substring(0, eqIdx).trim();

        if (updates.hasOwnProperty(key)) {
            updatedKeys.add(key);
            // Preserve inline comment if present
            const rest = line.substring(line.indexOf('=') + 1);
            const commentIdx = rest.indexOf(' #');
            const comment = commentIdx !== -1 ? rest.substring(commentIdx) : '';
            return `${key}=${updates[key]}${comment}`;
        }
        return line;
    });

    // Append any new keys that didn't exist
    const newKeys = Object.keys(updates).filter((k) => !updatedKeys.has(k));
    if (newKeys.length > 0) {
        newLines.push('');
        newLines.push('# Added by CineMeet Admin Panel');
        newKeys.forEach((k) => newLines.push(`${k}=${updates[k]}`));
    }

    fs.writeFileSync(ENV_FILE_PATH, newLines.join('\n'), 'utf8');
    return { success: true, updatedKeys: [...updatedKeys], newKeys };
}

/**
 * Get readable .env values (filter out secrets)
 */
const HIDDEN_KEYS = ['ADMIN_API_TOKEN', 'HOST_PASSWORD', 'OIDC_CLIENT_SECRET'];

function getPublicEnvSettings() {
    const raw = readEnvFile();
    const result = {};
    Object.keys(raw).forEach((key) => {
        if (HIDDEN_KEYS.includes(key)) {
            result[key] = { value: '***hidden***', comment: raw[key].comment };
        } else {
            result[key] = raw[key];
        }
    });
    return result;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * GET /admin-api/status
 * Returns server uptime, version, and basic metrics
 */
router.get('/status', (req, res) => {
    const uptimeSeconds = Math.floor(process.uptime());
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const seconds = uptimeSeconds % 60;

    const memUsage = process.memoryUsage();

    res.status(200).json({
        status: 'online',
        version: process.env.npm_package_version || '2.3.43',
        uptime: {
            seconds: uptimeSeconds,
            formatted: `${hours}h ${minutes}m ${seconds}s`,
        },
        memory: {
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + ' MB',
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + ' MB',
            rss: Math.round(memUsage.rss / 1024 / 1024) + ' MB',
        },
        domain: process.env.DOMAIN || process.env.SERVER_HOST_URL || 'https://cinemeet.cineworm.org',
        appName: process.env.APP_NAME || 'CineMeet',
        nodeVersion: process.version,
        platform: process.platform,
        timestamp: new Date().toISOString(),
    });
});

/**
 * GET /admin-api/settings
 * Returns all current .env settings (secrets hidden)
 */
router.get('/settings', (req, res) => {
    try {
        const settings = getPublicEnvSettings();

        // Return as flat key: value object for easier frontend use
        const flat = {};
        Object.keys(settings).forEach((k) => {
            flat[k] = settings[k].value;
        });

        res.status(200).json({ success: true, settings: flat });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /admin-api/settings
 * Body: { settings: { KEY: "value", ... }, restart: true|false }
 * Updates .env and optionally restarts PM2
 */
router.post('/settings', (req, res) => {
    const { settings, restart = true } = req.body;

    if (!settings || typeof settings !== 'object') {
        return res.status(400).json({ success: false, error: 'settings object is required' });
    }

    // Prevent updating hidden/dangerous keys via API
    const forbidden = Object.keys(settings).filter((k) => HIDDEN_KEYS.includes(k));
    if (forbidden.length > 0) {
        return res.status(403).json({
            success: false,
            error: `Cannot update protected keys via API: ${forbidden.join(', ')}`,
        });
    }

    try {
        const result = writeEnvFile(settings);
        if (!result.success) {
            return res.status(500).json({ success: false, error: result.error });
        }

        if (restart) {
            exec('pm2 restart cinemeet --update-env', (err, stdout, stderr) => {
                if (err) {
                    return res.status(200).json({
                        success: true,
                        message: 'Settings updated. PM2 restart failed (check manually).',
                        result,
                        restartError: err.message,
                    });
                }
                res.status(200).json({
                    success: true,
                    message: 'Settings updated and CineMeet restarted successfully.',
                    result,
                    restartOutput: stdout.trim(),
                });
            });
        } else {
            res.status(200).json({
                success: true,
                message: 'Settings updated. Restart skipped.',
                result,
            });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /admin-api/restart
 * Restarts the CineMeet PM2 process
 */
router.post('/restart', (req, res) => {
    exec('pm2 restart cinemeet --update-env', (err, stdout, stderr) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: 'PM2 restart failed',
                details: err.message,
            });
        }
        res.status(200).json({
            success: true,
            message: 'CineMeet restarted successfully.',
            output: stdout.trim(),
        });
    });
});

module.exports = router;
