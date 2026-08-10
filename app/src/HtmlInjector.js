const fs = require('fs');

const chokidar = require('chokidar');

const Logger = require('./Logger');

const log = new Logger('HtmlInjector');

class HtmlInjector {
    constructor(filesPath, config) {
        this.filesPath = filesPath; // Array of file paths to cache
        this.cache = {}; // Object to store cached files
        this.config = config; // Configuration containing metadata (OG, title, etc.)
        this.injectData = this.getInjectData(); // Initialize dynamic injection data
        this.watcher = null; // File watcher instance
        this.preloadPages(filesPath); // Preload pages at startup
        this.watchFiles(filesPath); // Watch files for changes
        log.info('filesPath cached', this.filesPath);
    }

    // Function to get dynamic data for injection (e.g., OG data, title, APP_NAME, etc.)
    getInjectData() {
        const appName = process.env.APP_NAME || this.config?.app?.name || 'CineMeet';
        return {
            APP_NAME: appName,
            APP_TITLE: `${appName} SFU`,
            ABOUT_SLIDES_URL: process.env.ABOUT_SLIDES_URL || '',
            OG_TYPE: this.config?.og?.type || 'app-webrtc',
            OG_SITE_NAME: `${appName} SFU`,
            OG_TITLE: this.config?.og?.title || `Click the link to start a ${appName} call.`,
            OG_DESCRIPTION:
                this.config?.og?.description ||
                `${appName} SFU powered by WebRTC and mediasoup, real-time video calls, messaging and screen sharing.`,
            OG_IMAGE: this.config?.og?.image || '../images/logo.svg',
            OG_URL: this.config?.og?.url || '',
        };
    }

    // Function to load a file into the cache
    loadFileToCache(filePath) {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            this.cache[filePath] = content; // Store the content in cache
        } catch (err) {
            log.error(`Error reading file: ${filePath}`, err);
        }
    }

    // Function to preload pages into the cache
    preloadPages(filePaths) {
        filePaths.forEach((filePath) => this.loadFileToCache(filePath));
    }

    // Function to watch files for changes using chokidar
    watchFiles(filePaths) {
        if (this.watcher) {
            this.watcher.close(); // Close existing watcher if any
        }

        this.watcher = chokidar.watch(filePaths, {
            persistent: true,
            ignoreInitial: true, // Ignore initial 'add' events
        });

        this.watcher
            .on('change', (filePath) => {
                log.debug(`File changed: ${filePath}`);
                this.loadFileToCache(filePath);
                log.debug(`Reloaded file ${filePath} into cache`);
            })
            .on('error', (error) => {
                log.error(`Watcher error: ${error.message}`);
            });
    }

    // Function to inject dynamic data (e.g., OG, TITLE, etc.) into a given file
    injectHtml(filePath, res) {
        // Check if HTML injection is enabled in the config
        if (!this.config?.htmlInjection) {
            return res.send(this.cache[filePath]);
        }

        if (!this.cache[filePath]) {
            this.loadFileToCache(filePath);
        }

        if (!this.cache[filePath]) {
            log.error(`File not cached: ${filePath}`);
            if (!res.headersSent) {
                return res.status(500).send('Server Error');
            }
            return;
        }

        try {
            const footerPath = require('path').join(__dirname, '../../public/views/footer.html');
            const footerContent = fs.existsSync(footerPath) ? fs.readFileSync(footerPath, 'utf-8') : '';

            // Replace placeholders with dynamic data (APP_NAME, FOOTER, OG, etc.)
            let modifiedHTML = this.cache[filePath]
                .replace(/{{FOOTER}}/g, footerContent)
                .replace(/{{([A-Z_]+)}}/g, (_, key) => (this.injectData[key] !== undefined ? this.injectData[key] : ''));

            if (!res.headersSent) {
                res.send(modifiedHTML);
            }
        } catch (error) {
            log.error('Error injecting HTML data:', error);
            if (!res.headersSent) {
                res.status(500).send('Server Error');
            }
        }
    }

    // Cleanup watcher when the instance is no longer needed
    cleanup() {
        if (this.watcher) {
            this.watcher.close();
        }
    }
}

module.exports = HtmlInjector;
