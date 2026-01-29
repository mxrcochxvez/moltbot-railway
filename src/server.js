const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 8080;
// Use env var or default to local 'data' directory for testing, fallback to /data if needed
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const CONFIG_MARKER = path.join(DATA_DIR, '.setup_complete');

// Ensure data directory exists
fs.ensureDirSync(DATA_DIR);

// Helper to start processes
let moltbotProcess = null;
let ttydProcess = null;

const startServices = () => {
    // Start Moltbot
    // Assuming 'clawdbot' is the executable (or node script)
    // In Dockerfile we created a wrapper script at /app/clawdbot-bin (or on PATH)
    console.log('Starting Moltbot...');
    // We point to the entry point. The Dockerfile put it at /clawdbot/dist/entry.js
    // and created a wrapper. Let's use the node command directly for better control
    // or the wrapper.
    
    // Using node directly:
    // We need to set env vars expected by moltbot if needed.
    // Assuming standard environment.
    moltbotProcess = spawn('node', ['/clawdbot/dist/entry.js'], {
        stdio: 'inherit',
        env: { ...process.env }
    });

    // Start ttyd
    console.log('Starting ttyd...');
    // ttyd -p 7681 bash
    // We run as the current user (railway)
    ttydProcess = spawn('ttyd', ['-p', '7681', '-W', 'bash'], {
        stdio: 'inherit'
    });
};

const setupProxy = () => {
    // Proxy for Terminal
    app.use('/terminal', createProxyMiddleware({ 
        target: 'http://localhost:7681', 
        changeOrigin: true,
        ws: true,
        pathRewrite: {
            '^/terminal': '' // strip /terminal from path if ttyd expects root
            // verify ttyd base path config. ttyd supports -b /basepath
        } 
    }));
    
    // Note: ttyd might need base path arg if proxied under /terminal
    // If we use pathRewrite, ttyd sees /. 
    // But resources might be requested relative to root.
    // Better to start ttyd with -b /terminal
    
    // Proxy for Moltbot (default catch-all)
    // Moltbot typically listens on 3000 or defined port.
    // We didn't set CLAWDBOT_PORT in Dockerfile, default is likely 3000.
    // But we need to check moltbot docs or existing env. 
    // Reference had ENV CLAWDBOT_PUBLIC_PORT=8080 but that was for the wrapper?
    // Let's assume Moltbot binds to some internal port. 
    // The reference used `clawdbot onboard` and then `exec node ...`.
    
    // If we run moltbot, we should tell it which port to listen on.
    // Common convention is PORT. But our wrapper owns PORT (8080).
    // So we tell Moltbot to listen on 3000.
    process.env.PORT = '3000'; // Override for child process? 
    // No, that overrides for THIS process if we just sat it.
    
    // We'll spawn moltbot with PORT=3000
    
    app.use('/', createProxyMiddleware({ 
        target: 'http://localhost:3000', 
        changeOrigin: true,
        ws: true 
    }));
};

const crypto = require('crypto');
require('dotenv').config({ path: path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), '.env') });

// ... existing code ...

const startApp = async () => {
    const isSetup = await fs.pathExists(CONFIG_MARKER);
    // Reload dotenv to ensure we capture any changes if we just wrote it (though restart catches this usually)
    require('dotenv').config({ path: path.join(DATA_DIR, '.env') });
    
    // Middleware for setup protection
    const checkSetupAuth = (req, res, next) => {
        if (!SETUP_PASSWORD) return next();

        const auth = { login: 'admin', password: SETUP_PASSWORD };
        const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
        const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

        if (login && password && login === auth.login && password === auth.password) {
            return next();
        }

        res.set('WWW-Authenticate', 'Basic realm="Moltbot Setup"');
        res.status(401).send('Authentication required for setup.');
    };

    if (isSetup) {
        // ... existing application mode logic ...
        console.log('Configuration found. Starting application mode.');
        
        // Ensure Gateway Token exists
        if (!process.env.CLAWDBOT_GATEWAY_TOKEN) {
             console.log('CLAWDBOT_GATEWAY_TOKEN not set. Generating one...');
             process.env.CLAWDBOT_GATEWAY_TOKEN = crypto.randomBytes(32).toString('hex');
        }

        // Restart ttyd with correct base path
        if (ttydProcess) ttydProcess.kill();
        ttydProcess = spawn('ttyd', ['-p', '7681', '-W', '-b', '/terminal', 'bash'], {
            stdio: 'inherit'
        });
        
        // Start Moltbot
        if (moltbotProcess) moltbotProcess.kill();
         moltbotProcess = spawn('node', ['/clawdbot/dist/entry.js'], {
            stdio: 'inherit',
            env: { 
                ...process.env, 
                PORT: '3000',
                CLAWDBOT_GATEWAY_TOKEN: process.env.CLAWDBOT_GATEWAY_TOKEN,
                BRAVE_API_KEY: process.env.BRAVE_API_KEY,
                // Ensure persistence overrides if not set in runtime env (though they should be)
                CLAWDBOT_STATE_DIR: process.env.CLAWDBOT_STATE_DIR || '/data/.clawdbot',
                CLAWDBOT_WORKSPACE_DIR: process.env.CLAWDBOT_WORKSPACE_DIR || '/data/workspace',
                CLAWDBOT_GATEWAY_BIND: process.env.CLAWDBOT_GATEWAY_BIND || '127.0.0.1'
            }
        });

        setupProxy();
    } else {
        console.log('Configuration missing. Starting setup mode.');
        
        // Apply auth to static files and api
        app.use(checkSetupAuth);
        app.use(express.static(path.join(__dirname, 'public')));
        app.use(bodyParser.json());

        app.post('/api/setup', async (req, res) => {
            try {
                const { llmSdkKey, botToken, provider, gatewayToken, braveApiKey } = req.body;
                
                // Use provided token or generate new one
                const finalGatewayToken = gatewayToken || crypto.randomBytes(32).toString('hex');

                console.log('Running setup...');
                
                // Write env file
                const envContent = `
LLM_PROVIDER=${provider}
LLM_API_KEY=${llmSdkKey}
DISCORD_TOKEN=${botToken}
CLAWDBOT_GATEWAY_TOKEN=${finalGatewayToken}
BRAVE_API_KEY=${braveApiKey || ''}
                `;
                await fs.writeFile(path.join(DATA_DIR, '.env'), envContent);
                
                await fs.writeFile(CONFIG_MARKER, 'active');
                
                res.json({ success: true, message: 'Setup complete. Restarting...' });
                
                setTimeout(() => process.exit(0), 1000);
                
            } catch (error) {
                console.error('Setup failed:', error);
                res.status(500).json({ success: false, message: error.message });
            }
        });
    }
    // ...

    app.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
    });
};

startApp();
