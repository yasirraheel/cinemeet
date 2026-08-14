'use strict';

const config = require('../config');

/**
 * Embed (iframe) restrictions.
 * Controls which origins may embed MiroTalk SFU in an <iframe> via CSP
 * `frame-ancestors` (and `X-Frame-Options` for legacy browsers).
 * Configured via ALLOWED_EMBED_ORIGINS env var. See config.server.embed.
 */
const embedAllowedOrigins = Array.isArray(config?.server?.embed?.allowedOrigins)
    ? config.server.embed.allowedOrigins
    : [];

function buildEmbedCsp(origins) {
    const sources = ["'self'", "https://cineworm.org", "https://*.cineworm.org"];
    if (Array.isArray(origins)) {
        for (const o of origins) {
            const v = (o || '').trim();
            if (v && !sources.includes(v)) sources.push(v);
        }
    }
    return { csp: `frame-ancestors ${sources.join(' ')}`, xfo: null };
}

const embedCsp = buildEmbedCsp(embedAllowedOrigins);

const applyEmbedHeaders = (req, res, next) => {
    if (embedCsp) {
        // Merge with any existing CSP header set earlier in the chain
        const existing = res.getHeader('Content-Security-Policy');
        const merged = existing ? `${existing}; ${embedCsp.csp}` : embedCsp.csp;
        res.setHeader('Content-Security-Policy', merged);
        if (embedCsp.xfo) {
            res.setHeader('X-Frame-Options', embedCsp.xfo);
        }
    }
    next();
};

module.exports = {
    applyEmbedHeaders,
    buildEmbedCsp,
    embedAllowedOrigins,
    embedCsp,
};
