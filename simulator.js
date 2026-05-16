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
const SIM_TTL_MS = 4 * 60 * 60 * 1000; // 4 horas
const SIM_SYSTEM_PROMPT = `Estás en MODO SIMULACIÓN. Usá http://localhost:4002 como base URL de la API.

Objetivo del simulador: ayudar al usuario a evaluar procesos, no solo resultados.
En cada respuesta explicá de forma clara y visible:
1) qué entendiste del pedido,
2) qué datos consultaste o vas a consultar,
3) qué decisión tomaste y por qué,
4) qué acción concreta hiciste o harías en el sistema.

No reveles cadena interna de pensamiento ni razonamiento oculto; explicá el criterio operativo de manera resumida, auditable y útil para corregir procedimientos.
Si una acción crea/modifica datos, aclaralo explícitamente y recordá que estás trabajando sobre una base clonada de simulación.`;

module.exports = function(app, pool, authenticate) {
  const simulations = {};
  ensureArchitectDrafts(pool).catch(err => console.error('[architect] Error creando architect_drafts:', err));

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

      const sim = { child, client_id: req.user.client_id, started_at: new Date(), expires_at: new Date(Date.now() + SIM_TTL_MS), session_key: `sim:${req.user.client_id}:${Date.now()}`, cleanup_timer: null };
      sim.cleanup_timer = setTimeout(() => {
        cleanupSimulation(pool, simulations, req.user.client_id, 'ttl-expired').catch(err => {
          console.error('[simulator] Error en cleanup TTL:', err);
        });
      }, SIM_TTL_MS);
      simulations[req.user.client_id] = sim;

      let initialReply = null;
      try {
        const initResponse = await callChatCompletions(GW_PORT, GW_TOKEN, GW_MODEL, [
          { role: 'system', content: SIM_SYSTEM_PROMPT },
          { role: 'user', content: 'Inicializá esta simulación. Explicá brevemente cómo vas a trabajar: que vas a mostrar datos consultados, decisiones y acciones para que el usuario pueda corregir procesos.' }
        ], sim.session_key);
        initialReply = initResponse?.choices?.[0]?.message?.content || null;
      } catch (initErr) {
        console.error('[simulator] No se pudo inicializar sesión conversacional:', initErr.message || initErr);
      }

      res.json({
        ok: true,
        session_id: req.user.client_id,
        backend_port: SIM_PORT,
        model: GW_MODEL,
        gateway_port: GW_PORT,
        expires_at: sim.expires_at,
        ttl_hours: 4,
        session_key: sim.session_key,
        initial_reply: initialReply
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
        { role: 'system', content: SIM_SYSTEM_PROMPT },
        { role: 'user', content: message }
      ], sim.session_key);

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
      if (sim) {
        await cleanupSimulation(pool, simulations, req.user.client_id, 'manual-stop');
      } else {
        // Idempotente: si el backend principal se reinició, pudo perder el estado
        // en memoria aunque sigan vivos demo_sim y/o el backend 4002.
        await cleanupOrphanSimulation(pool, 'manual-stop-orphan');
      }

      res.json({ ok: true, message: 'Simulación finalizada. BD clonada eliminada.' });
    } catch (err) {
      console.error('[simulator] Error en stop:', err);
      res.status(500).json({ error: 'Error al detener simulación: ' + err.message });
    }
  });

    // ─── ARCHITECT: ANALYZE → DRAFT → APPLY ──────────────────
  app.post('/api/architect/analyze', authenticate, async (req, res) => {
    try {
      const { message } = req.body;
      if (!message) return res.status(400).json({ error: 'message es requerido' });

      const agentId = await getDefaultAgentId(pool, req.user.client_id);
      const classification = await classifyArchitectMessage(message);
      const type = classification.type || 'ambiguous';
      const targetTable = targetTableForType(type);
      const payload = normalizeArchitectPayload(classification, message);

      const draftResult = await pool.query(
        `INSERT INTO architect_drafts
          (client_id, agent_id, original_message, type, action, target_table, payload, confidence, reason, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
         RETURNING *`,
        [req.user.client_id, agentId, message, type, classification.action || 'create', targetTable, payload, Number(classification.confidence || 0.5), classification.reason || 'Clasificación propuesta por LLM']
      );

      res.json({ ok: true, draft: draftResult.rows[0] });
    } catch (err) {
      console.error('[architect] Error analyze:', err);
      res.status(500).json({ error: 'Error al analizar enseñanza: ' + err.message });
    }
  });

  // Backcompat: el chat del arquitecto ahora solo genera borrador, no escribe directo en knowledge.
  app.post('/api/architect/chat', authenticate, async (req, res) => {
    try {
      const { message } = req.body;
      if (!message) return res.status(400).json({ error: 'message es requerido' });
      const agentId = await getDefaultAgentId(pool, req.user.client_id);
      const classification = await classifyArchitectMessage(message);
      const type = classification.type || 'ambiguous';
      const draftResult = await pool.query(
        `INSERT INTO architect_drafts
          (client_id, agent_id, original_message, type, action, target_table, payload, confidence, reason, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
         RETURNING *`,
        [req.user.client_id, agentId, message, type, classification.action || 'create', targetTableForType(type), normalizeArchitectPayload(classification, message), Number(classification.confidence || 0.5), classification.reason || 'Clasificación propuesta por LLM']
      );
      res.json({ ok: true, reply: 'Generé una propuesta. Revisala y confirmá antes de guardar.', draft: draftResult.rows[0], knowledge_saved: false });
    } catch (err) {
      console.error('[architect] Error chat:', err);
      res.status(500).json({ error: 'Error al analizar enseñanza: ' + err.message });
    }
  });

  app.post('/api/architect/drafts/:id/apply', authenticate, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const draftRes = await client.query(
        `SELECT * FROM architect_drafts WHERE id=$1 AND client_id=$2 FOR UPDATE`,
        [req.params.id, req.user.client_id]
      );
      const draft = draftRes.rows[0];
      if (!draft) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Borrador no encontrado' });
      }
      if (draft.status !== 'pending') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'El borrador ya fue procesado' });
      }
      if (draft.type === 'ambiguous') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Borrador ambiguo: editá o reclasificá antes de guardar' });
      }

      const applied = await applyArchitectDraft(client, draft);
      await client.query(
        `UPDATE architect_drafts SET status='applied', applied_ref=$1, updated_at=NOW() WHERE id=$2`,
        [applied, draft.id]
      );
      await client.query('COMMIT');
      res.json({ ok: true, applied });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[architect] Error apply:', err);
      res.status(500).json({ error: 'Error al aplicar borrador: ' + err.message });
    } finally {
      client.release();
    }
  });

  app.post('/api/architect/drafts/:id/discard', authenticate, async (req, res) => {
    try {
      const r = await pool.query(
        `UPDATE architect_drafts SET status='discarded', updated_at=NOW() WHERE id=$1 AND client_id=$2 AND status='pending' RETURNING *`,
        [req.params.id, req.user.client_id]
      );
      res.json({ ok: true, draft: r.rows[0] || null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── STATUS ─────────────────────────────────────────────
  app.get('/api/simulator/:clientId/status', authenticate, async (req, res) => {
    const sim = simulations[parseInt(req.params.clientId)];
    if (!sim) {
      const db = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [SIM_DB]);
      return res.json({ active: db.rowCount > 0, orphan: db.rowCount > 0, backend_port: db.rowCount > 0 ? SIM_PORT : undefined });
    }
    res.json({
      active: true,
      started_at: sim.started_at,
      pid: sim.child.pid,
      backend_port: SIM_PORT,
      expires_at: sim.expires_at,
      ttl_hours: 4,
      session_key: sim.session_key
    });
  });
};

// ─── Helpers ──────────────────────────────────────────────

async function ensureArchitectDrafts(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS architect_drafts (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
      original_message TEXT NOT NULL,
      type VARCHAR(40) NOT NULL,
      action VARCHAR(20) NOT NULL DEFAULT 'create',
      target_table VARCHAR(60),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      confidence DOUBLE PRECISION DEFAULT 0.5,
      reason TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      applied_ref JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_architect_drafts_client_status ON architect_drafts(client_id, status)`);
}

async function getDefaultAgentId(pool, clientId) {
  const r = await pool.query('SELECT id FROM agents WHERE deleted_at IS NULL AND client_id=$1 ORDER BY id LIMIT 1', [clientId]);
  return r.rows[0]?.id || 1;
}

function targetTableForType(type) {
  if (type === 'knowledge') return 'agent_knowledge';
  if (type === 'permanent_instruction' || type === 'transient_instruction') return 'agent_instructions';
  if (type === 'procedure') return 'agent_procedures';
  return null;
}

function normalizeArchitectPayload(classification, originalMessage) {
  const p = classification.payload || {};
  const content = p.content || classification.summary || originalMessage;
  if (classification.type === 'knowledge') {
    return {
      category: p.category || 'manual_instruction',
      content,
      confidence: Number(p.confidence || classification.confidence || 0.8),
      source: 'manual'
    };
  }
  if (classification.type === 'permanent_instruction') {
    return { type: 'permanent', content, sort_order: Number(p.sort_order || 0) };
  }
  if (classification.type === 'transient_instruction') {
    return { type: 'transient', content, sort_order: Number(p.sort_order || 0), expires_hint: p.expires_hint || null };
  }
  if (classification.type === 'procedure') {
    return {
      context: p.context || 'general',
      step_order: Number(p.step_order || 0),
      step_name: p.step_name || classification.summary || 'Nuevo paso',
      step_prompt: p.step_prompt || content,
      active: true
    };
  }
  return { content, note: 'ambiguous' };
}

async function classifyArchitectMessage(message) {
  const system = `Sos un clasificador del modo Arquitecto de un agente comercial/retail.
Clasificá la enseñanza del usuario en EXACTAMENTE uno de estos types:
- knowledge: dato contextual, excepción, preferencia, patrón o hecho del negocio. Informa decisiones, no ordena conducta global.
- permanent_instruction: regla estable de conducta que el agente debe obedecer siempre o por defecto.
- transient_instruction: instrucción temporal, campaña, promo o regla con vigencia limitada.
- procedure: secuencia de pasos, workflow o proceso operativo.
- ambiguous: no queda claro si debe guardarse o dónde.

Devolvé SOLO JSON válido, sin markdown, con esta forma:
{
  "type": "knowledge|permanent_instruction|transient_instruction|procedure|ambiguous",
  "confidence": 0.0,
  "reason": "breve explicación",
  "summary": "versión limpia para guardar",
  "action": "create",
  "payload": { }
}

Payload esperado:
- knowledge: {"category":"payment_behavior|client_preference|business_rule|schedule_pattern|stock_threshold|cross_sell|manual_instruction", "content":"..."}
- permanent_instruction/transient_instruction: {"content":"...", "expires_hint":"solo si temporal"}
- procedure: {"context":"lead_nuevo|lead_caliente|cliente|admin|general", "step_name":"...", "step_prompt":"...", "step_order":0}
Si hay mezcla de tipos, elegí el dominante y explicalo en reason.`;

  const response = await callChatCompletions(GW_PORT, GW_TOKEN, GW_REAL_MODEL, [
    { role: 'system', content: system },
    { role: 'user', content: message }
  ]);
  const raw = response?.choices?.[0]?.message?.content || '';
  return parseModelJson(raw);
}

function parseModelJson(raw) {
  const original = String(raw || '').trim();
  const candidates = [];

  // Preferir bloques ```json ... ```; si el agente habló de más, el último bloque suele ser la clasificación final.
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = fenceRe.exec(original))) {
    candidates.push(match[1].trim());
  }

  // Fallback: desde el último objeto con "type" hasta la última llave.
  const typeIdx = original.lastIndexOf('"type"');
  if (typeIdx >= 0) {
    const first = original.lastIndexOf('{', typeIdx);
    const last = original.lastIndexOf('}');
    if (first >= 0 && last > first) candidates.push(original.slice(first, last + 1));
  }

  // Último fallback: objeto completo más amplio.
  const first = original.indexOf('{');
  const last = original.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(original.slice(first, last + 1));

  for (const text of candidates.reverse()) {
    try {
      const parsed = JSON.parse(text);
      const allowed = ['knowledge','permanent_instruction','transient_instruction','procedure','ambiguous'];
      if (!allowed.includes(parsed.type)) parsed.type = 'ambiguous';
      return parsed;
    } catch (_) {}
  }

  return { type: 'ambiguous', confidence: 0.1, reason: 'No pude parsear JSON del clasificador', summary: original, payload: { content: original } };
}

async function applyArchitectDraft(client, draft) {
  const p = draft.payload || {};
  if (draft.type === 'knowledge') {
    const r = await client.query(
      `INSERT INTO agent_knowledge (client_id, category, content, confidence, source)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [draft.client_id, p.category || 'manual_instruction', p.content, Number(p.confidence || draft.confidence || 0.8), p.source || 'manual']
    );
    return { table: 'agent_knowledge', id: r.rows[0].id };
  }
  if (draft.type === 'permanent_instruction' || draft.type === 'transient_instruction') {
    const r = await client.query(
      `INSERT INTO agent_instructions (agent_id, type, content, sort_order)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [draft.agent_id || 1, p.type || (draft.type === 'permanent_instruction' ? 'permanent' : 'transient'), p.content, Number(p.sort_order || 0)]
    );
    return { table: 'agent_instructions', id: r.rows[0].id };
  }
  if (draft.type === 'procedure') {
    const r = await client.query(
      `INSERT INTO agent_procedures (agent_id, context, step_order, step_name, step_prompt, active)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [draft.agent_id || 1, p.context || 'general', Number(p.step_order || 0), p.step_name || 'Nuevo paso', p.step_prompt || p.content, p.active !== false]
    );
    return { table: 'agent_procedures', id: r.rows[0].id };
  }
  throw new Error('Tipo de borrador no aplicable: ' + draft.type);
}

async function cleanupSimulation(pool, simulations, clientId, reason) {
  const sim = simulations[clientId];
  if (!sim) return false;

  if (sim.cleanup_timer) clearTimeout(sim.cleanup_timer);

  if (sim.child && !sim.child.killed) {
    sim.child.kill('SIGTERM');
    setTimeout(() => {
      try {
        if (!sim.child.killed) sim.child.kill('SIGKILL');
      } catch (_) {}
    }, 3000);
  }

  await dropSimDatabase(pool);
  delete simulations[clientId];
  console.log(`[simulator] Cleanup completo (${reason}) para client ${clientId}`);
  return true;
}

async function cleanupOrphanSimulation(pool, reason) {
  await killPort(SIM_PORT);
  await dropSimDatabase(pool);
  console.log(`[simulator] Cleanup orphan completo (${reason})`);
}

async function dropSimDatabase(pool) {
  await pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [SIM_DB]);
  await pool.query(`DROP DATABASE IF EXISTS ${SIM_DB}`);
}

function killPort(port) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-lc', `fuser -k ${port}/tcp >/dev/null 2>&1 || true`], { stdio: 'ignore' });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}

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

function callChatCompletions(gwPort, gwToken, model, messages, sessionKey = null) {
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
        ...(sessionKey ? { 'x-openclaw-session-key': sessionKey, 'x-openclaw-agent-id': 'demo-agent-sim', 'x-openclaw-message-channel': 'simulator' } : {}),
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
