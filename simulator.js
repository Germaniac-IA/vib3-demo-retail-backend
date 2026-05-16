// Módulo Simulador VIB3
// Crea BD clonada + backend en puerto 4002 + gateway Chat Completions
const { spawn } = require('child_process');
const http = require('http');

const SIM_PORT = 4002;
const SIM_DB = 'demo_sim';
const GW_PORT = 18790;
const GW_TOKEN = 'demo-gateway-token-2026';
const GW_MODEL = 'openclaw/demo-agent-sim';
const GW_REAL_MODEL = 'openclaw/demo-agent';
const DB_URL = 'postgresql://demo_user:V1b3_D3m0_2026@localhost:5432';

module.exports = function(app, pool, authenticate) {
  const simulations = {};

  // ─── START ──────────────────────────────────────────────
  app.post('/api/simulator/start', authenticate, async (req, res) => {
    try {
      if (simulations[req.user.client_id]) {
        return res.status(409).json({ error: 'Ya hay una simulación activa para este cliente' });
      }

      // 1. Crear BD clonada
      await pool.query(`DROP DATABASE IF EXISTS ${SIM_DB}`);
      await pool.query(`CREATE DATABASE ${SIM_DB} TEMPLATE demo_retail`);
      console.log(`[simulator] Clone DB created: ${SIM_DB}`);

      // 2. Spawn backend en puerto 4002 con la BD clonada
      const child = spawn('node', ['server.js'], {
        cwd: '/var/www/demo/vib3-demo-retail/backend',
        env: {
          ...process.env,
          PORT: String(SIM_PORT),
          DATABASE_URL: `${DB_URL}/${SIM_DB}`
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      child.stdout.on('data', d => process.stdout.write(`[sim:4002] ${d}`));
      child.stderr.on('data', d => process.stderr.write(`[sim:4002] ${d}`));

      // Esperar a que el backend esté listo
      await waitForServer(SIM_PORT, 15000);

      const sim = { child, client_id: req.user.client_id, started_at: new Date() };
      simulations[req.user.client_id] = sim;

      res.json({
        ok: true,
        session_id: req.user.client_id,
        backend_port: SIM_PORT,
        model: GW_MODEL,
        gateway_port: GW_PORT
      });
    } catch (err) {
      console.error('[simulator] Error en start:', err);
      res.status(500).json({ error: 'Error al iniciar simulación: ' + err.message });
    }
  });

  // ─── CHAT ───────────────────────────────────────────────
  app.post('/api/simulator/:clientId/chat', authenticate, async (req, res) => {
    try {
      const sim = simulations[parseInt(req.params.clientId)];
      if (!sim) {
        return res.status(404).json({ error: 'No hay simulación activa. Iniciá una con /api/simulator/start' });
      }

      const { message } = req.body;
      if (!message) return res.status(400).json({ error: 'message es requerido' });

      // Llamar al Chat Completions del gateway
      const response = await callChatCompletions(GW_PORT, GW_TOKEN, GW_MODEL, [
        { role: 'system', content: 'Estás en MODO SIMULACIÓN. Usá http://localhost:4002 como base URL de la API. Contestá como lo harías normalmente, mostrando tu razonamiento si aplica.' },
        { role: 'user', content: message }
      ]);

      res.json({
        ok: true,
        reply: response.choices[0].message.content,
        usage: response.usage,
        model: response.model
      });
    } catch (err) {
      console.error('[simulator] Error en chat:', err);
      res.status(500).json({ error: 'Error al procesar mensaje: ' + err.message });
    }
  });

  // ─── STOP ───────────────────────────────────────────────
  app.post('/api/simulator/:clientId/stop', authenticate, async (req, res) => {
    try {
      const sim = simulations[parseInt(req.params.clientId)];
      if (!sim) {
        return res.status(404).json({ error: 'No hay simulación activa' });
      }

      // Matar backend
      sim.child.kill('SIGTERM');
      setTimeout(() => sim.child.kill('SIGKILL'), 3000);

      // Dropear BD clonada
      await pool.query(`DROP DATABASE IF EXISTS ${SIM_DB}`);

      delete simulations[req.user.client_id];

      res.json({ ok: true, message: 'Simulación finalizada. BD clonada eliminada.' });
    } catch (err) {
      console.error('[simulator] Error en stop:', err);
      res.status(500).json({ error: 'Error al detener simulación: ' + err.message });
    }
  });

    // ─── ARCHITECT CHAT ─────────────────────────────────────
  app.post('/api/architect/chat', authenticate, async (req, res) => {
    try {
      const { message } = req.body;
      if (!message) return res.status(400).json({ error: 'message es requerido' });

      // Enviar al agente REAL (no simulación)
      const response = await callChatCompletions(GW_PORT, GW_TOKEN, GW_REAL_MODEL, [
        { role: 'system', content: 'INSTRUCCIÓN IMPORTANTE: Estás en MODO ARQUITECTO. El usuario te va a enseñar cosas sobre su negocio que debeS recordar. EJECUTÁ SIEMPRE save_knowledge cuando el usuario te diga algo como "quiero que sepas", "recordá", "importante", "tené en cuenta", "Pérez es...", o cualquier instrucción sobre cómo manejar clientes, productos, pagos o stock. Usá category="correction" y el contenido exacto. No digas solo "entendido" sin guardar.' },
        { role: 'user', content: message }
      ]);

      // Fallback: guardar automáticamente si el mensaje parece una enseñanza
      const enseñanzas = ['quiero que sepas', 'recorda', 'importante', 'tenelo en cuenta',
        'no le bloquees', 'es confiable', 'caso especial', 'excepción',
        'especial', 'cuidado con', 'atención con'];
      const esEnseñanza = enseñanzas.some(p => message.toLowerCase().includes(p));

      if (esEnseñanza) {
        await pool.query(
          'INSERT INTO agent_knowledge (client_id, category, content, confidence, source) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
          [req.user.client_id, 'correction', message, 0.8, 'manual']
        );
        console.log('[architect] Enseñanza guardada automáticamente');
      }

      res.json({
        ok: true,
        reply: response.choices[0].message.content,
        usage: response.usage,
        knowledge_saved: esEnseñanza
      });
    } catch (err) {
      console.error('[architect] Error:', err);
      res.status(500).json({ error: 'Error al procesar mensaje: ' + err.message });
    }
  });

  // ─── STATUS ─────────────────────────────────────────────
  app.get('/api/simulator/:clientId/status', authenticate, async (req, res) => {
    const sim = simulations[parseInt(req.params.clientId)];
    if (!sim) return res.json({ active: false });
    res.json({
      active: true,
      started_at: sim.started_at,
      pid: sim.child.pid,
      backend_port: SIM_PORT
    });
  });
};

// ─── Helpers ──────────────────────────────────────────────
function waitForServer(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(`http://localhost:${port}/api/health`, (res) => {
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timeout esperando puerto ${port}`));
        } else {
          setTimeout(check, 500);
        }
      });
      req.end();
    };
    check();
  });
}

function callChatCompletions(gwPort, gwToken, model, messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages, max_tokens: 1000 });
    const req = http.request({
      hostname: 'localhost',
      port: gwPort,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${gwToken}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch(e) {
          reject(new Error('Error parsing response: ' + data));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
