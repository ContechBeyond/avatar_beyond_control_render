'use strict';
const ACTIONS = new Set(['presentacion', 'saludo', 'detener', 'continuar', 'tema', 'cierre']);
const ROUTES = new Set(['brief', 'executive', 'full']);
function normalizeCommand(body) {
    if (!body || !ACTIONS.has(body.action)) return null;
    const command = { action: body.action };
    if (body.action === 'presentacion') {
        const route = body.route ?? 'executive';
        if (!ROUTES.has(route) || (body.guided !== undefined && typeof body.guided !== 'boolean')) return null;
        command.route = route;
        command.guided = body.guided ?? false;
    }
    if (body.action === 'tema') {
        if (!Number.isInteger(body.topic) || body.topic < 1 || body.topic > 8) return null;
        command.topic = body.topic;
    }
    return command;
}
const canInterrupt = action => ['detener', 'continuar', 'tema', 'cierre'].includes(action);
module.exports = { normalizeCommand, canInterrupt };
