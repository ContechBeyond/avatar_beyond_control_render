'use strict';
const el = id => document.getElementById(id);
let csrf = '', state = null, busy = false, timer;
const topics = ['', 'Bienvenida y concepto Beyond', 'El SOC como cerebro de la operación', 'Accesos y llaves con trazabilidad', 'Video inteligente, drones y robótica', 'Protección de unidades y mercancías en ruta', 'Personas y respuesta coordinada', 'Kits Beyond y valor para cada cliente', 'Invitación a conocer el SOC'];

async function api(path, options = {}) {
    const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) };
    let response;
    try { response = await fetch('/api/' + path, { ...options, headers, credentials: 'same-origin', signal: AbortSignal.timeout(16000) }); }
    catch { throw new Error('No se pudo confirmar la acción. Revisa la conexión y el estado antes de volver a intentar.'); }
    const data = await response.json();
    if (response.status === 401 && path !== 'login') showLogin();
    if (!response.ok) throw new Error(data.error || 'No se pudo completar la acción.');
    return data;
}

function showLogin() {
    clearTimeout(timer);
    csrf = '';
    state = null;
    el('dashboard').hidden = true;
    el('logout').hidden = true;
    el('login').hidden = false;
}

function showDashboard() {
    el('login').hidden = true;
    el('dashboard').hidden = false;
    el('logout').hidden = false;
    el('access-key').value = '';
    poll();
}

function feedback(message, kind = '') {
    el('feedback').textContent = message;
    el('feedback').className = 'feedback ' + kind;
}

function render() {
    const ready = !!state?.connected && !!state?.avatar?.ready;
    const available = ready && state.avatar.canStart && !state.commandPending && !busy;
    const showroom = ready && state.avatar.showroomVersion === 2;
    const labels = { IDLE: 'Listo para recibir visitas', WELCOME: 'Dando la bienvenida', PRESENTATION: 'Presentando Beyond', FAREWELL: 'Despidiendo a la visita', RETURN_TO_IDLE: 'Volviendo a reposo' };
    el('connection-pill').textContent = ready ? 'Conectado' : 'Sin conexión';
    el('connection-pill').className = 'pill' + (ready ? ' online' : '');
    el('status-orbit').className = 'status-orbit' + (ready ? ' online' : '');
    el('state-title').textContent = ready ? (labels[state.avatar.state] || 'Avatar conectado') : state?.deviceConnected ? 'Esperando al avatar' : 'Equipo desconectado';
    el('state-description').textContent = ready ? (state.commandPending ? 'Esperando la confirmación de tu última acción.' : state.avatar.state === 'IDLE' ? 'Puedes iniciar una nueva experiencia.' : 'La experiencia está en curso en el tótem.') : state?.deviceConnected ? 'Abre el avatar en el equipo del SOC.' : 'Comprueba que el equipo y el enlace remoto estén encendidos.';
    if (showroom && state.avatar.topic) {
        el('state-title').textContent = state.avatar.waitingForContinue ? 'Esperando para continuar' : 'Tema ' + state.avatar.topic + ' · ' + topics[state.avatar.topic];
        el('state-description').textContent = state.avatar.waitingForContinue ? 'Puedes continuar, elegir otro tema o pasar al SOC.' : 'Puedes pasar al siguiente tema o al cierre en cualquier momento.';
    }
    el('presentation').disabled = !available;
    el('welcome').disabled = !available;
    el('stop').disabled = !ready || busy || (state.avatar.state === 'IDLE' && !state.commandPending);
    el('continue').disabled = !showroom || busy || !state.avatar.canContinue;
    el('closing').disabled = !showroom || busy;
    el('play-topic').disabled = !showroom || busy;
    el('route').disabled = busy || (ready && !showroom);
    el('guided').disabled = busy || (ready && !showroom);
}

async function poll() {
    clearTimeout(timer);
    if (!csrf) return;
    try { state = await api('state'); render(); }
    catch (error) {
        state = null;
        render();
        if (csrf) feedback('No hay conexión con el panel. Volveremos a intentar automáticamente.', 'error');
    }
    if (csrf) timer = setTimeout(poll, 2000);
}

async function command(body) {
    if (busy) return;
    busy = true;
    render();
    feedback('Enviando al tótem…');
    try {
        await api('commands', { method: 'POST', body: JSON.stringify(body) });
        const messages = { presentacion: 'Recorrido iniciado en el tótem.', saludo: 'Bienvenida iniciada en el tótem.', detener: 'Presentación detenida.', continuar: 'Avanzando al siguiente tema.', tema: 'Tema iniciado en el tótem.', cierre: 'Invitación al SOC iniciada.' };
        feedback(messages[body.action], 'success');
    } catch (error) { feedback(error.message, 'error'); }
    finally { busy = false; await poll(); }
}

el('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    el('login-button').disabled = true;
    el('login-message').textContent = '';
    try {
        const result = await api('login', { method: 'POST', body: JSON.stringify({ key: el('access-key').value }) });
        csrf = result.csrf;
        showDashboard();
    } catch (error) { el('login-message').textContent = error.message; }
    finally { el('login-button').disabled = false; }
});
el('logout').addEventListener('click', async () => {
    try { await api('logout', { method: 'POST', body: '{}' }); showLogin(); }
    catch (error) { feedback(error.message, 'error'); }
});
el('presentation').addEventListener('click', () => command({ action: 'presentacion', route: el('route').value, guided: el('guided').checked }));
el('welcome').addEventListener('click', () => command({ action: 'saludo' }));
el('stop').addEventListener('click', () => command({ action: 'detener' }));
el('continue').addEventListener('click', () => command({ action: 'continuar' }));
el('closing').addEventListener('click', () => command({ action: 'cierre' }));
el('play-topic').addEventListener('click', () => command({ action: 'tema', topic: Number(el('topic').value) }));
el('route').addEventListener('change', () => { el('route-description').textContent = { brief: 'Bienvenida e invitación al SOC', executive: 'Recorrido ejecutivo del showroom', full: 'Los ocho temas del showroom' }[el('route').value]; });
document.addEventListener('visibilitychange', () => { if (!document.hidden && csrf) poll(); });
(async () => {
    try { csrf = (await api('session')).csrf; showDashboard(); }
    catch { showLogin(); }
})();
