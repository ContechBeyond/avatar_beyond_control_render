const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID, createHash, timingSafeEqual } = require('node:crypto');

const STATES = new Set(['IDLE', 'WELCOME', 'PRESENTATION', 'FAREWELL', 'RETURN_TO_IDLE']);
const digest = value => createHash('sha256').update(String(value)).digest();
const equal = (value, expected) => timingSafeEqual(digest(value), digest(expected));

function createControlServer(options = {}) {
    const controlKey = options.controlKey || process.env.CONTROL_ACCESS_KEY;
    const deviceToken = options.deviceToken || process.env.DEVICE_TOKEN;
    if (!controlKey || controlKey.length < 12 || !deviceToken || deviceToken.length < 24 || equal(controlKey, deviceToken))
        throw new Error('Configura CONTROL_ACCESS_KEY (12 caracteres mínimo) y DEVICE_TOKEN (24 mínimo), con valores distintos.');
    const secureCookies = options.secureCookies ?? (process.env.NODE_ENV === 'production');
    const commandTTL = options.commandTTL || 12000;
    const onlineTTL = options.onlineTTL || 12000;
    const sessions = new Map();
    const attempts = new Map();
    const pending = new Map();
    let queue = [];
    let device = null;
    const publicDir = path.join(__dirname, 'public');

    function send(res, code, data) {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
    }

    async function readJson(req) {
        if (!String(req.headers['content-type'] || '').startsWith('application/json'))
            throw Object.assign(new Error('Envía datos en formato JSON.'), { status: 415 });
        let size = 0, chunks = [];
        for await (const chunk of req) {
            size += chunk.length;
            if (size > 8192) throw Object.assign(new Error('La solicitud es demasiado grande.'), { status: 413 });
            chunks.push(chunk);
        }
        try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
            return body;
        } catch {
            throw Object.assign(new Error('Datos inválidos.'), { status: 400 });
        }
    }

    function session(req) {
        const cookie = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('beyond_session='));
        if (!cookie) return null;
        const found = sessions.get(digest(cookie.slice('beyond_session='.length)).toString('hex'));
        if (!found || found.expiresAt < Date.now()) return null;
        return found;
    }

    function sameOrigin(req) {
        if (!req.headers.origin) return true;
        try { return new URL(req.headers.origin).host === req.headers.host; }
        catch { return false; }
    }

    function snapshot() {
        const online = !!device && Date.now() - device.lastSeen < onlineTTL;
        const connected = online && device.status.connected && device.status.fresh;
        return {
            deviceConnected: online,
            connected: !!connected,
            avatar: online ? device.status.avatar : null,
            lastSeen: device ? new Date(device.lastSeen).toISOString() : null,
            commandPending: pending.size > 0
        };
    }

    function normalizeStatus(status) {
        const avatar = status?.avatar;
        return {
            connected: status?.connected === true,
            fresh: status?.fresh === true,
            avatar: avatar && avatar.protocol === 1 && STATES.has(avatar.state) ? {
                state: avatar.state, ready: avatar.ready === true, canStart: avatar.canStart === true
            } : null
        };
    }

    function finish(id, code, data) {
        const entry = pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(id);
        queue = queue.filter(command => command.id !== id);
        entry.resolve({ code, data: { requestId: id, ...data } });
    }

    const server = http.createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        const url = new URL(req.url, 'http://localhost');
        try {
            if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
            if (req.method === 'GET' && url.pathname === '/robots.txt') {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                return res.end('User-agent: *\nDisallow: /\n');
            }
            if (req.method === 'GET' && ['/', '/index.html', '/app.js', '/styles.css'].includes(url.pathname)) {
                const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
                const types = { 'index.html': 'text/html', 'app.js': 'text/javascript', 'styles.css': 'text/css' };
                res.writeHead(200, { 'Content-Type': types[file] + '; charset=utf-8' });
                return res.end(fs.readFileSync(path.join(publicDir, file)));
            }
            if (req.method === 'POST' && url.pathname === '/api/device/sync') {
                const authorization = String(req.headers.authorization || '');
                if (!authorization.startsWith('Bearer ') || !equal(authorization.slice(7), deviceToken))
                    return send(res, 401, { error: 'Credencial de equipo inválida.' });
                const body = await readJson(req);
                if (!/^[a-zA-Z0-9-]{16,80}$/.test(body.instanceId || ''))
                    return send(res, 400, { error: 'Identificador de equipo inválido.' });
                if (device && Date.now() - device.lastSeen < onlineTTL && device.instanceId !== body.instanceId)
                    return send(res, 409, { error: 'Ya hay otro enlace activo para este tótem.' });
                device = { instanceId: body.instanceId, lastSeen: Date.now(), status: normalizeStatus(body.status) };
                for (const result of (Array.isArray(body.results) ? body.results.slice(0, 8) : [])) {
                    const entry = pending.get(result.id);
                    if (!entry || entry.assignedTo !== body.instanceId) continue;
                    const accepted = result.status === 202 && result.accepted === true;
                    const code = accepted ? 202 : [400, 409, 429, 503, 504].includes(result.status) ? result.status : 503;
                    finish(result.id, code, {
                        accepted,
                        ...(accepted ? {} : { error: typeof result.error === 'string' ? result.error.slice(0, 240) : 'El tótem no pudo confirmar el comando.' })
                    });
                }
                const commands = [];
                while (queue.length && commands.length < 1) {
                    const command = queue.shift();
                    const entry = pending.get(command.id);
                    if (!entry || command.expiresAt <= Date.now()) continue;
                    entry.assignedTo = body.instanceId;
                    commands.push(command);
                }
                return send(res, 200, { commands });
            }

            if (req.method === 'POST' && url.pathname === '/api/login') {
                if (!sameOrigin(req)) return send(res, 403, { error: 'Origen no permitido.' });
                const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',').at(-1).trim().slice(0, 100);
                const entry = attempts.get(ip);
                if (entry && entry.until > Date.now() && entry.failures >= 8)
                    return send(res, 429, { error: 'Demasiados intentos. Espera diez minutos.' });
                if (sessions.size >= 128) return send(res, 429, { error: 'Hay demasiadas sesiones activas.' });
                const body = await readJson(req);
                if (typeof body.key !== 'string' || body.key.length > 256 || !equal(body.key, controlKey)) {
                    const current = entry && entry.until > Date.now() ? entry : { failures: 0, until: Date.now() + 600000 };
                    current.failures++;
                    attempts.set(ip, current);
                    return send(res, 401, { error: 'La clave de acceso no es correcta.' });
                }
                attempts.delete(ip);
                const token = randomBytes(32).toString('base64url');
                const csrf = randomBytes(24).toString('base64url');
                sessions.set(digest(token).toString('hex'), { csrf, expiresAt: Date.now() + 8 * 3600000 });
                res.setHeader('Set-Cookie', 'beyond_session=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800' + (secureCookies ? '; Secure' : ''));
                return send(res, 200, { csrf });
            }

            if (url.pathname.startsWith('/api/')) {
                const current = session(req);
                if (!current) return send(res, 401, { error: 'Inicia sesión para controlar el tótem.' });
                if (req.method !== 'GET' && (!sameOrigin(req) || !equal(req.headers['x-csrf-token'] || '', current.csrf)))
                    return send(res, 403, { error: 'La sesión no pudo validar esta acción. Recarga la página.' });
                if (req.method === 'GET' && url.pathname === '/api/session') return send(res, 200, { csrf: current.csrf });
                if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, snapshot());
                if (req.method === 'POST' && url.pathname === '/api/logout') {
                    const token = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('beyond_session='))?.slice(15);
                    if (token) sessions.delete(digest(token).toString('hex'));
                    res.setHeader('Set-Cookie', 'beyond_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + (secureCookies ? '; Secure' : ''));
                    return send(res, 200, { ok: true });
                }
                if (req.method === 'POST' && url.pathname === '/api/commands') {
                    const body = await readJson(req);
                    const { action } = body;
                    if (!['presentacion', 'saludo', 'detener'].includes(action))
                        return send(res, 400, { error: 'Acción no disponible.' });
                    const state = snapshot();
                    if (!state.connected || !state.avatar?.ready)
                        return send(res, 503, { error: 'El tótem está desconectado o todavía no está listo.' });
                    if (pending.size >= 8 || (pending.size && action !== 'detener'))
                        return send(res, 409, { error: 'Hay una acción en curso. Espera su confirmación.' });
                    if (['saludo', 'presentacion'].includes(action) && !state.avatar.canStart)
                        return send(res, 409, { error: 'El avatar está hablando. Espera a que termine o pulsa Detener.' });
                    const id = randomUUID();
                    const outcome = await new Promise(resolve => {
                        const timer = setTimeout(() => finish(id, 504, { accepted: false, error: 'No llegó la confirmación del tótem. Revisa su estado antes de volver a intentar.' }), commandTTL);
                        pending.set(id, { resolve, timer, assignedTo: null });
                        queue.push({ id, action, expiresAt: Date.now() + commandTTL });
                        res.on('close', () => {
                            if (!res.writableEnded) finish(id, 499, { accepted: false });
                        });
                    });
                    return send(res, outcome.code, outcome.data);
                }
            }
            send(res, 404, { error: 'Página no encontrada.' });
        } catch (error) {
            send(res, error.status || 500, { error: error.status ? error.message : 'No se pudo completar la solicitud.' });
        }
    });

    const cleanup = setInterval(() => {
        for (const [id, value] of sessions) if (value.expiresAt < Date.now()) sessions.delete(id);
        for (const [id, value] of attempts) if (value.until < Date.now()) attempts.delete(id);
    }, 60000);
    cleanup.unref();
    server.headersTimeout = 15000;
    server.requestTimeout = 20000;
    server.on('close', () => {
        clearInterval(cleanup);
        for (const id of pending.keys()) finish(id, 503, { error: 'El servicio se está reiniciando.' });
    });
    return server;
}

if (require.main === module) {
    try {
        const server = createControlServer();
        server.listen(Number(process.env.PORT || 3001), '0.0.0.0', () => console.log('Panel Beyond disponible en el puerto ' + server.address().port));
        const stop = () => server.close(() => process.exit(0));
        process.on('SIGTERM', stop);
        process.on('SIGINT', stop);
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}
module.exports = { createControlServer };

