const fs = require('fs');
const path = require('path');

function applyDevServerEnv(env = process.env) {
    env.MULTIPLAYER_MODE = 'false';
    env.STATIC_PORT = env.STATIC_PORT || '8000';
    env.ENABLE_POLICY_SERVER = env.ENABLE_POLICY_SERVER || 'false';
    env.ENABLE_MONGO_GAME_DATA = 'false';
    env.GAME_MONGODB_URI = '';
    env.MONGODB_URI = '';
    env.SPONSOR_MONGODB_URI = '';
    env.SPONSOR_ACCOUNT_CREATION_REQUIRED = 'false';
}

/**
 * Mirrors the whole dev session into logs/dev-<timestamp>.log and makes crashes
 * loud: a Flash-side crash report (packet 0x7C) or a server throw used to scroll
 * past in a terminal nobody was watching, or die with the process before it was
 * written anywhere.
 */
function installCrashLogging(logDir = path.resolve(__dirname, '..', 'logs')) {
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `dev-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    const log = fs.createWriteStream(logPath, { flags: 'a' });

    for (const streamName of ['stdout', 'stderr']) {
        const stream = process[streamName];
        const write = stream.write.bind(stream);
        stream.write = (chunk, encoding, callback) => {
            try {
                log.write(typeof chunk === 'string' ? chunk : Buffer.from(chunk));
            } catch {
                // Never let logging break the server's own output.
            }
            return write(chunk, encoding, callback);
        };
    }

    const report = (label, error) => {
        const detail = error instanceof Error ? (error.stack || error.message) : String(error);
        console.error(`[dev-crash] ${label} at ${new Date().toISOString()}\n${detail}`);
    };

    process.on('uncaughtException', (error) => {
        report('uncaughtException', error);
        log.end(() => process.exit(1));
    });
    process.on('unhandledRejection', (reason) => {
        report('unhandledRejection', reason);
    });
    process.on('warning', (warning) => {
        report('warning', warning);
    });
    process.on('exit', (code) => {
        if (code !== 0) {
            process.stderr.write(`[dev-crash] exiting with code ${code}; log: ${logPath}\n`);
        }
    });

    console.log(`[dev] session log: ${logPath}`);
    return logPath;
}

function startDevServer() {
    require('../scripts/cleanup-dev-instance');
    applyDevServerEnv();
    installCrashLogging();

    require('ts-node/register');
    require('../main.ts');
}

if (require.main === module) {
    startDevServer();
}

module.exports = {
    applyDevServerEnv,
    installCrashLogging,
    startDevServer
};
