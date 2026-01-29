const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const bodyParser = require('body-parser');
const crypto = require('crypto');

// ============================================================================
// Configuration
// ============================================================================
const app = express();
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const WORKSPACE_DIR = process.env.CLAWDBOT_WORKSPACE_DIR || path.join(DATA_DIR, 'workspace');
const CONFIG_MARKER = path.join(DATA_DIR, '.setup_complete');

// Ensure directories exist
fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(WORKSPACE_DIR);

// Load environment from persisted .env
require('dotenv').config({ path: path.join(DATA_DIR, '.env') });

// ============================================================================
// Process Management
// ============================================================================
let moltbotProcess = null;
let ttydProcess = null;

/**
 * Spawns a managed child process with logging.
 */
function spawnService(name, cmd, args, opts = {}) {
    console.log(`[${name}] Starting: ${cmd} ${args.join(' ')}`);
    const proc = spawn(cmd, args, { stdio: 'inherit', ...opts });
    
    proc.on('error', (err) => console.error(`[${name}] Error: ${err.message}`));
    proc.on('exit', (code, signal) => console.log(`[${name}] Exited (code=${code}, signal=${signal})`));
    
    return proc;
}

/**
 * Graceful shutdown handler.
 */
function setupGracefulShutdown() {
    const shutdown = (signal) => {
        console.log(`\n[wrapper] Received ${signal}. Shutting down...`);
        if (moltbotProcess) moltbotProcess.kill('SIGTERM');
        if (ttydProcess) ttydProcess.kill('SIGTERM');
        setTimeout(() => process.exit(0), 1000);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

// ============================================================================
// Authentication Middleware
// ============================================================================
function createAuthMiddleware() {
    return (req, res, next) => {
        const SETUP_PASSWORD = process.env.SETUP_PASSWORD;
        if (!SETUP_PASSWORD) return next(); // No password = no auth

        const header = req.headers.authorization || '';
        const [scheme, encoded] = header.split(' ');
        
        if (scheme !== 'Basic' || !encoded) {
            res.set('WWW-Authenticate', 'Basic realm="Moltbot Setup"');
            return res.status(401).send('Authentication required.');
        }
        
        const decoded = Buffer.from(encoded, 'base64').toString('utf8');
        const colonIdx = decoded.indexOf(':');
        const user = decoded.slice(0, colonIdx);
        const pass = decoded.slice(colonIdx + 1);
        
        // Timing-safe comparison
        const expectedPass = Buffer.from(SETUP_PASSWORD);
        const providedPass = Buffer.from(pass);
        
        if (user === 'admin' && expectedPass.length === providedPass.length &&
            crypto.timingSafeEqual(expectedPass, providedPass)) {
            return next();
        }
        
        res.set('WWW-Authenticate', 'Basic realm="Moltbot Setup"');
        return res.status(401).send('Invalid credentials.');
    };
}

// ============================================================================
// Health Check (Always Available)
// ============================================================================
app.get('/health', async (req, res) => {
    const initialized = await fs.pathExists(CONFIG_MARKER);
    res.json({
        status: initialized ? 'active' : 'setup_needed',
        initialized,
        services: {
            moltbot: moltbotProcess && !moltbotProcess.killed ? 'running' : 'stopped',
            ttyd: ttydProcess && !ttydProcess.killed ? 'running' : 'stopped'
        },
        uptime: process.uptime()
    });
});

// ============================================================================
// Main Application Logic
// ============================================================================
async function startApp() {
    setupGracefulShutdown();
    
    const isSetup = await fs.pathExists(CONFIG_MARKER);
    const authMiddleware = createAuthMiddleware();
    
    if (isSetup) {
        // ======================== APPLICATION MODE ========================
        console.log('[wrapper] Configuration found. Starting application mode.');
        
        // Ensure Gateway Token
        if (!process.env.CLAWDBOT_GATEWAY_TOKEN) {
            process.env.CLAWDBOT_GATEWAY_TOKEN = crypto.randomBytes(32).toString('hex');
            console.log('[wrapper] Generated new CLAWDBOT_GATEWAY_TOKEN.');
        }
        
        // Start Services
        ttydProcess = spawnService('ttyd', 'ttyd', ['-p', '7681', '-W', '-b', '/terminal', 'bash']);
        moltbotProcess = spawnService('moltbot', 'node', ['/clawdbot/dist/entry.js'], {
            env: {
                ...process.env,
                PORT: '3000',
                CLAWDBOT_STATE_DIR: process.env.CLAWDBOT_STATE_DIR || '/data/.clawdbot',
                CLAWDBOT_WORKSPACE_DIR: WORKSPACE_DIR,
                CLAWDBOT_GATEWAY_BIND: process.env.CLAWDBOT_GATEWAY_BIND || '127.0.0.1'
            }
        });
        
        // Track if Moltbot is ready
        let moltbotReady = false;
        setTimeout(() => { moltbotReady = true; }, 5000); // Give it 5 seconds to start
        
        // Fallback page if Moltbot isn't responding
        app.get('/', async (req, res, next) => {
            if (!moltbotReady || !moltbotProcess || moltbotProcess.killed) {
                return res.status(503).send(`
                    <html><body style="font-family:system-ui;padding:2rem;background:#111;color:#fff">
                    <h1>⏳ Moltbot Starting...</h1>
                    <p>The AI agent is initializing. This page will refresh automatically.</p>
                    <p>If this persists, check the Railway logs for errors.</p>
                    <script>setTimeout(() => location.reload(), 5000);</script>
                    </body></html>
                `);
            }
            next();
        });
        
        // --- Protected Endpoints (App Mode) ---
        app.use(bodyParser.json());
        
        app.post('/api/setup/pairing/approve', authMiddleware, (req, res) => {
            const { code, channel } = req.body;
            if (!code) return res.status(400).json({ ok: false, output: 'Missing code' });
            
            const proc = spawn('node', ['/clawdbot/dist/entry.js', 'pairing', 'approve', channel || 'telegram', code]);
            let output = '';
            proc.stdout.on('data', d => output += d.toString());
            proc.stderr.on('data', d => output += d.toString());
            proc.on('close', (exitCode) => res.json({ ok: exitCode === 0, output }));
        });
        
        app.get('/setup/export', authMiddleware, async (req, res) => {
            const tar = require('tar');
            res.setHeader('content-type', 'application/gzip');
            res.setHeader('content-disposition', `attachment; filename="clawdbot-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz"`);
            tar.c({ gzip: true, cwd: path.dirname(DATA_DIR), filter: p => !p.includes('node_modules') }, [path.basename(DATA_DIR)]).pipe(res);
        });
        
        app.post('/api/setup/reset', authMiddleware, async (req, res) => {
            try {
                await fs.remove(CONFIG_MARKER);
                res.json({ success: true, message: 'Reset complete. Reloading...' });
                setTimeout(() => process.exit(0), 1000);
            } catch (e) {
                res.status(500).json({ success: false, message: e.message });
            }
        });
        
        // --- Proxies ---
        app.use('/terminal', createProxyMiddleware({ target: 'http://localhost:7681', changeOrigin: true, ws: true }));
        app.use('/', createProxyMiddleware({ target: 'http://localhost:3000', changeOrigin: true, ws: true }));
        
    } else {
        // ======================== SETUP MODE ========================
        console.log('[wrapper] Configuration missing. Starting setup mode.');
        
        app.use(authMiddleware);
        app.use(express.static(path.join(__dirname, 'public')));
        app.use(bodyParser.json());
        
        app.get('/api/setup/status', (req, res) => {
            res.json({
                hasBraveKey: !!process.env.BRAVE_API_KEY,
                hasGatewayToken: !!process.env.CLAWDBOT_GATEWAY_TOKEN,
                hasLlmKey: !!process.env.LLM_API_KEY,
                hasBotToken: !!process.env.DISCORD_TOKEN || !!process.env.TELEGRAM_TOKEN
            });
        });
        
        app.post('/api/setup', async (req, res) => {
            try {
                const { llmSdkKey, botToken, provider, gatewayToken, braveApiKey, platform } = req.body;
                
                const finalGatewayToken = gatewayToken || process.env.CLAWDBOT_GATEWAY_TOKEN || crypto.randomBytes(32).toString('hex');
                const finalBraveKey = braveApiKey || process.env.BRAVE_API_KEY || '';
                const finalLlmKey = llmSdkKey || process.env.LLM_API_KEY || '';
                const isDiscord = platform === 'discord';
                const finalDiscordToken = isDiscord ? (botToken || process.env.DISCORD_TOKEN || '') : '';
                const finalTelegramToken = !isDiscord ? (botToken || process.env.TELEGRAM_TOKEN || '') : '';
                
                const envContent = `LLM_PROVIDER=${provider}
LLM_API_KEY=${finalLlmKey}
DISCORD_TOKEN=${finalDiscordToken}
TELEGRAM_TOKEN=${finalTelegramToken}
CLAWDBOT_GATEWAY_TOKEN=${finalGatewayToken}
BRAVE_API_KEY=${finalBraveKey}
`;
                await fs.writeFile(path.join(DATA_DIR, '.env'), envContent);
                await fs.writeFile(CONFIG_MARKER, 'active');
                
                res.json({ success: true, message: 'Setup complete. Restarting...' });
                setTimeout(() => process.exit(0), 1000);
                
            } catch (error) {
                console.error('[setup] Failed:', error);
                res.status(500).json({ success: false, message: error.message });
            }
        });
    }
    
    app.listen(PORT, () => console.log(`[wrapper] Server listening on port ${PORT}`));
}

startApp();
