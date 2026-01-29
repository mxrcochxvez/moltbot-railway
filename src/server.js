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
console.log('[wrapper] Starting Moltbot wrapper...');

const app = express();
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const WORKSPACE_DIR = process.env.CLAWDBOT_WORKSPACE_DIR || path.join(DATA_DIR, 'workspace');
const CONFIG_MARKER = path.join(DATA_DIR, '.setup_complete');

console.log('[wrapper] Configuration:', { PORT, DATA_DIR, WORKSPACE_DIR, CONFIG_MARKER });

// Ensure directories exist
try {
    fs.ensureDirSync(DATA_DIR);
    fs.ensureDirSync(WORKSPACE_DIR);
    console.log('[wrapper] Directories created/verified.');
} catch (e) {
    console.error('[wrapper] Failed to create directories:', e);
}

// Load environment from persisted .env
try {
    require('dotenv').config({ path: path.join(DATA_DIR, '.env') });
    console.log('[wrapper] Loaded .env file.');
} catch (e) {
    console.log('[wrapper] No .env file or failed to load:', e.message);
}

// ============================================================================
// Process Management
// ============================================================================
let moltbotProcess = null;
let ttydProcess = null;
let moltbotReady = false;

function spawnService(name, cmd, args, opts = {}) {
    console.log(`[${name}] Spawning: ${cmd} ${args.join(' ')}`);
    
    try {
        const proc = spawn(cmd, args, { stdio: 'inherit', ...opts });
        
        proc.on('error', (err) => {
            console.error(`[${name}] Spawn error: ${err.message}`);
        });
        
        proc.on('exit', (code, signal) => {
            console.log(`[${name}] Exited (code=${code}, signal=${signal})`);
            if (name === 'moltbot') moltbotReady = false;
        });
        
        return proc;
    } catch (e) {
        console.error(`[${name}] Failed to spawn: ${e.message}`);
        return null;
    }
}

function setupGracefulShutdown() {
    const shutdown = (signal) => {
        console.log(`[wrapper] Received ${signal}. Shutting down...`);
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
        if (!SETUP_PASSWORD) return next();

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
        moltbotReady,
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
    console.log('[wrapper] Starting app...');
    setupGracefulShutdown();
    
    let isSetup = false;
    try {
        isSetup = await fs.pathExists(CONFIG_MARKER);
        console.log('[wrapper] Setup status:', isSetup);
    } catch (e) {
        console.error('[wrapper] Failed to check setup status:', e);
    }
    
    const authMiddleware = createAuthMiddleware();
    
    if (isSetup) {
        // ======================== APPLICATION MODE ========================
        console.log('[wrapper] Entering APPLICATION MODE.');
        
        // Ensure Gateway Token
        if (!process.env.CLAWDBOT_GATEWAY_TOKEN) {
            process.env.CLAWDBOT_GATEWAY_TOKEN = crypto.randomBytes(32).toString('hex');
            console.log('[wrapper] Generated new gateway token.');
        }
        
        // Start Services (with error handling)
        try {
            ttydProcess = spawnService('ttyd', 'ttyd', ['-p', '7681', '-W', '-b', '/terminal', 'bash']);
        } catch (e) {
            console.error('[wrapper] ttyd spawn failed:', e);
        }
        
        try {
            moltbotProcess = spawnService('moltbot', 'node', ['/clawdbot/dist/entry.js'], {
                env: {
                    ...process.env,
                    PORT: '3000',
                    CLAWDBOT_STATE_DIR: process.env.CLAWDBOT_STATE_DIR || '/data/.clawdbot',
                    CLAWDBOT_WORKSPACE_DIR: WORKSPACE_DIR,
                    CLAWDBOT_GATEWAY_BIND: process.env.CLAWDBOT_GATEWAY_BIND || '127.0.0.1'
                }
            });
            
            // Mark ready after 5 seconds
            setTimeout(() => { 
                moltbotReady = true; 
                console.log('[wrapper] Moltbot marked as ready.');
            }, 5000);
        } catch (e) {
            console.error('[wrapper] Moltbot spawn failed:', e);
        }
        
        app.use(bodyParser.json());
        
        // Status page while Moltbot starts
        app.get('/', (req, res, next) => {
            if (!moltbotReady) {
                return res.send(`
                    <!DOCTYPE html>
                    <html><head><meta charset="utf-8"><title>Starting...</title></head>
                    <body style="font-family:system-ui;padding:2rem;background:#111;color:#fff;text-align:center">
                    <h1>⏳ Moltbot is starting...</h1>
                    <p>The AI agent is initializing. This page will refresh automatically.</p>
                    <p style="color:#888">If this persists for more than 30 seconds, check Railway logs.</p>
                    <script>setTimeout(() => location.reload(), 3000);</script>
                    </body></html>
                `);
            }
            next();
        });
        
        // Pairing endpoint
        app.post('/api/setup/pairing/approve', authMiddleware, (req, res) => {
            const { code, channel } = req.body;
            if (!code) return res.status(400).json({ ok: false, output: 'Missing code' });
            
            const proc = spawn('node', ['/clawdbot/dist/entry.js', 'pairing', 'approve', channel || 'telegram', code]);
            let output = '';
            proc.stdout.on('data', d => output += d.toString());
            proc.stderr.on('data', d => output += d.toString());
            proc.on('close', (exitCode) => res.json({ ok: exitCode === 0, output }));
        });
        
        // Export endpoint
        app.get('/setup/export', authMiddleware, async (req, res) => {
            try {
                const tar = require('tar');
                res.setHeader('content-type', 'application/gzip');
                res.setHeader('content-disposition', `attachment; filename="clawdbot-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz"`);
                tar.c({ gzip: true, cwd: path.dirname(DATA_DIR), filter: p => !p.includes('node_modules') }, [path.basename(DATA_DIR)]).pipe(res);
            } catch (e) {
                res.status(500).send('Export failed: ' + e.message);
            }
        });
        
        // Reset endpoint
        app.post('/api/setup/reset', authMiddleware, async (req, res) => {
            try {
                await fs.remove(CONFIG_MARKER);
                res.json({ success: true, message: 'Reset complete. Reloading...' });
                setTimeout(() => process.exit(0), 1000);
            } catch (e) {
                res.status(500).json({ success: false, message: e.message });
            }
        });
        
        // Proxies
        app.use('/terminal', createProxyMiddleware({ 
            target: 'http://localhost:7681', 
            changeOrigin: true, 
            ws: true,
            onError: (err, req, res) => {
                console.error('[proxy:terminal] Error:', err.message);
                res.status(502).send('Terminal not available');
            }
        }));
        
        app.use('/', createProxyMiddleware({ 
            target: 'http://localhost:3000', 
            changeOrigin: true, 
            ws: true,
            onError: (err, req, res) => {
                console.error('[proxy:moltbot] Error:', err.message);
                res.status(502).send('Moltbot not available. Check logs.');
            }
        }));
        
    } else {
        // ======================== SETUP MODE ========================
        console.log('[wrapper] Entering SETUP MODE.');
        
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
            console.log('[setup] Received setup request.');
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
                
                console.log('[setup] Setup complete. Restarting...');
                res.json({ success: true, message: 'Setup complete. Restarting...' });
                
                setTimeout(() => process.exit(0), 1000);
                
            } catch (error) {
                console.error('[setup] Failed:', error);
                res.status(500).json({ success: false, message: error.message });
            }
        });
    }
    
    // Start listening
    app.listen(PORT, () => {
        console.log(`[wrapper] Server listening on port ${PORT}`);
    });
}

// Catch any uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('[wrapper] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[wrapper] Unhandled rejection at:', promise, 'reason:', reason);
});

startApp().catch(err => {
    console.error('[wrapper] Failed to start:', err);
    process.exit(1);
});
