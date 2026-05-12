// Plugin: Producción
// Pipeline de sub-etapas para órdenes en estado "pedido"
// Diseño → Impresión → Corte → Confección → Empaquetado

module.exports = function(app, pool, authenticate) {

  function checkPlugin(req, res, next) {
    const cid = req.user?.client_id;
    if (!cid) return res.status(401).json({ error: 'No autenticado' });
    pool.query("SELECT plugins FROM clients WHERE id = $1 AND deleted_at IS NULL", [cid])
      .then(({ rows }) => {
        if (!rows.length || !rows[0].plugins || !rows[0].plugins.includes('produccion')) {
          return res.status(403).json({ error: 'Plugin no activo para este cliente' });
        }
        next();
      })
      .catch(e => res.status(500).json({ error: e.message }));
  }

  app.get('/api/plugins/produccion/stages', authenticate, checkPlugin, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM production_stages WHERE client_id = $1 AND is_active = true ORDER BY sort_order',
        [req.user.client_id]
      );
      res.json(result.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/plugins/produccion/init/:orderId', authenticate, checkPlugin, async (req, res) => {
    const { orderId } = req.params;
    const cid = req.user.client_id;
    try {
      const stages = await pool.query(
        'SELECT id FROM production_stages WHERE client_id = $1 ORDER BY sort_order LIMIT 1',
        [cid]
      );
      if (!stages.rows.length) return res.status(400).json({ error: 'No hay stages configurados' });
      const firstStageId = stages.rows[0].id;

      const items = await pool.query(
        `SELECT oi.id FROM order_items oi
         JOIN orders o ON oi.order_id = o.id
         WHERE o.id = $1 AND o.client_id = $2 AND o.deleted_at IS NULL
         AND oi.deleted_at IS NULL AND (SELECT os.name FROM order_statuses os WHERE os.id = o.order_status_id) = 'Pedido'
         AND NOT EXISTS (SELECT 1 FROM production_order_items poi WHERE poi.order_item_id = oi.id AND poi.deleted_at IS NULL)`,
        [orderId, cid]
      );

      if (!items.rows.length) return res.json({ message: 'Sin items nuevos para producir', count: 0 });

      let created = 0;
      for (const item of items.rows) {
        await pool.query(
          `INSERT INTO production_order_items (client_id, order_id, order_item_id, current_stage_id, status, started_at)
           VALUES ($1, $2, $3, $4, 'in_progress', NOW())`,
          [cid, orderId, item.id, firstStageId]
        );
        created++;
      }
      res.json({ success: true, count: created });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/plugins/produccion/pipeline', authenticate, checkPlugin, async (req, res) => {
    const cid = req.user.client_id;
    try {
      const items = await pool.query(
        `SELECT poi.*, ps.name as stage_name, ps.sort_order,
                p.name as product_name, oi.quantity, oi.unit_price,
                o.id as order_id, o.order_number, (SELECT os.name FROM order_statuses os WHERE os.id = o.order_status_id) as order_status,
                c.name as client_name
         FROM production_order_items poi
         JOIN production_stages ps ON poi.current_stage_id = ps.id
         JOIN order_items oi ON poi.order_item_id = oi.id
         JOIN products p ON oi.product_id = p.id
         JOIN orders o ON poi.order_id = o.id
         JOIN clients c ON poi.client_id = c.id
         WHERE poi.client_id = $1 AND poi.deleted_at IS NULL AND (SELECT os.name FROM order_statuses os WHERE os.id = o.order_status_id) = 'Pedido'
         ORDER BY ps.sort_order, poi.created_at DESC`,
        [cid]
      );
      const stages = await pool.query(
        'SELECT id, name, sort_order FROM production_stages WHERE client_id = $1 AND is_active = true ORDER BY sort_order',
        [cid]
      );
      const grouped = stages.rows.map(s => ({
        ...s,
        items: items.rows.filter(r => r.current_stage_id === s.id)
      }));
      res.json({ stages: grouped, all_items: items.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Stage CRUD (admin configuration) ────────────────────────────────────
app.post('/api/plugins/produccion/stages', authenticate, checkPlugin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nombre requerido' });
  try {
    // Get max sort_order
    const max = await pool.query('SELECT COALESCE(MAX(sort_order), 0) + 1 as next_sort FROM production_stages WHERE client_id = $1', [req.user.client_id]);
    const result = await pool.query(
      'INSERT INTO production_stages (client_id, name, sort_order) VALUES ($1, $2, $3) RETURNING *',
      [req.user.client_id, name.trim(), max.rows[0].next_sort]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/plugins/produccion/stages/:id', authenticate, checkPlugin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nombre requerido' });
  try {
    const result = await pool.query(
      'UPDATE production_stages SET name = $1, updated_at = NOW() WHERE id = $2 AND client_id = $3 RETURNING *',
      [name.trim(), req.params.id, req.user.client_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Stage no encontrado' });
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/plugins/produccion/stages/:id', authenticate, checkPlugin, async (req, res) => {
  try {
    // Check if any production items reference this stage
    const refs = await pool.query(
      'SELECT COUNT(*) as count FROM production_order_items WHERE current_stage_id = $1 AND deleted_at IS NULL',
      [req.params.id]
    );
    if (parseInt(refs.rows[0].count) > 0) {
      return res.status(400).json({ error: 'No se puede eliminar: hay items produccion en esta etapa' });
    }
    const result = await pool.query(
      'DELETE FROM production_stages WHERE id = $1 AND client_id = $2',
      [req.params.id, req.user.client_id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Stage no encontrado' });
    // Re-index sort_order for remaining stages
    const remaining = await pool.query(
      'SELECT id FROM production_stages WHERE client_id = $1 ORDER BY sort_order',
      [req.user.client_id]
    );
    for (let i = 0; i < remaining.rows.length; i++) {
      await pool.query('UPDATE production_stages SET sort_order = $1 WHERE id = $2', [i + 1, remaining.rows[i].id]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/plugins/produccion/stages/:id/sort', authenticate, checkPlugin, async (req, res) => {
  try {
    const stage = await pool.query('SELECT id FROM production_stages WHERE id = $1 AND client_id = $2', [req.params.id, req.user.client_id]);
    if (!stage.rows.length) return res.status(404).json({ error: 'Stage no encontrado' });

    const { sort_order } = req.body;
    if (typeof sort_order !== 'number' || sort_order < 1) return res.status(400).json({ error: 'sort_order invalido' });

    // Shift other stages
    const all = await pool.query(
      'SELECT id, sort_order FROM production_stages WHERE client_id = $1 AND id != $2 ORDER BY sort_order',
      [req.user.client_id, req.params.id]
    );

    // We'll assign sequentially: insert target at desired position, shift rest
    const stages = [{ id: parseInt(req.params.id), sort_order }];
    let pos = 1;
    for (const s of all.rows) {
      if (pos === sort_order) pos++; // skip the target position
      stages.push({ id: s.id, sort_order: pos });
      pos++;
    }

    // Re-sort using temporary negative values to avoid unique constraint clashes
    // First set all to negative, then set final
    for (const s of stages) {
      await pool.query('UPDATE production_stages SET sort_order = $1 WHERE id = $2', [-s.sort_order, s.id]);
    }
    for (const s of stages) {
      await pool.query('UPDATE production_stages SET sort_order = $1 WHERE id = $2', [s.sort_order, s.id]);
    }

    const updated = await pool.query(
      'SELECT * FROM production_stages WHERE client_id = $1 ORDER BY sort_order',
      [req.user.client_id]
    );
    res.json(updated.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.patch('/api/plugins/produccion/advance/:itemId', authenticate, checkPlugin, async (req, res) => {
    const cid = req.user.client_id;
    try {
      const item = await pool.query(
        `SELECT poi.*, ps.sort_order FROM production_order_items poi
         JOIN production_stages ps ON poi.current_stage_id = ps.id
         WHERE poi.id = $1 AND poi.client_id = $2 AND poi.deleted_at IS NULL`,
        [req.params.itemId, cid]
      );
      if (!item.rows.length) return res.status(404).json({ error: 'Item no encontrado' });

      const nextStage = await pool.query(
        'SELECT id FROM production_stages WHERE client_id = $1 AND sort_order = $2 AND is_active = true',
        [cid, item.rows[0].sort_order + 1]
      );
      if (!nextStage.rows.length) return res.status(400).json({ error: 'Ya está en la última etapa' });

      const oldStageId = item.rows[0].current_stage_id;
      const newStageId = nextStage.rows[0].id;
      const isLast = item.rows[0].sort_order + 1 === 6;

      await pool.query(
        `UPDATE production_order_items SET current_stage_id = $1, status = $2, updated_at = NOW() WHERE id = $3`,
        [newStageId, isLast ? 'completed' : 'in_progress', req.params.itemId]
      );

      await pool.query(
        `INSERT INTO production_item_log (production_item_id, from_stage_id, to_stage_id, status, notes, created_by)
         VALUES ($1, $2, $3, 'completed', $4, $5)`,
        [req.params.itemId, oldStageId, newStageId, req.body.notes || null, req.user.id]
      );

      res.json({ success: true, new_stage_id: newStageId, completed: isLast });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/plugins/produccion/rollback/:itemId', authenticate, checkPlugin, async (req, res) => {
    const cid = req.user.client_id;
    try {
      const item = await pool.query(
        `SELECT poi.*, ps.sort_order FROM production_order_items poi
         JOIN production_stages ps ON poi.current_stage_id = ps.id
         WHERE poi.id = $1 AND poi.client_id = $2 AND poi.deleted_at IS NULL`,
        [req.params.itemId, cid]
      );
      if (!item.rows.length) return res.status(404).json({ error: 'Item no encontrado' });

      const prevStage = await pool.query(
        'SELECT id FROM production_stages WHERE client_id = $1 AND sort_order = $2 AND is_active = true',
        [cid, item.rows[0].sort_order - 1]
      );
      if (!prevStage.rows.length) return res.status(400).json({ error: 'Ya está en la primera etapa' });

      await pool.query(
        `UPDATE production_order_items SET current_stage_id = $1, status = 'in_progress', updated_at = NOW() WHERE id = $2`,
        [prevStage.rows[0].id, req.params.itemId]
      );
      await pool.query(
        `INSERT INTO production_item_log (production_item_id, from_stage_id, to_stage_id, status, notes, created_by)
         VALUES ($1, $2, $3, 'rework', $4, $5)`,
        [req.params.itemId, item.rows[0].current_stage_id, prevStage.rows[0].id, req.body.notes || 'Retrocedido', req.user.id]
      );
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/plugins/produccion/block/:itemId', authenticate, checkPlugin, async (req, res) => {
    try {
      await pool.query(
        `UPDATE production_order_items SET status = 'blocked', notes = COALESCE($1, notes), updated_at = NOW()
         WHERE id = $2 AND deleted_at IS NULL`,
        [req.body.notes || null, req.params.itemId]
      );
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/plugins/produccion/unblock/:itemId', authenticate, checkPlugin, async (req, res) => {
    try {
      await pool.query(
        `UPDATE production_order_items SET status = 'in_progress', updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL`,
        [req.params.itemId]
      );
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/plugins/produccion/item/:itemId', authenticate, checkPlugin, async (req, res) => {
    const { notes, assigned_to } = req.body;
    try {
      const sets = [];
      const vals = [];
      if (notes !== undefined) { sets.push('notes = $' + (vals.length+1)); vals.push(notes); }
      if (assigned_to !== undefined) { sets.push('assigned_to = $' + (vals.length+1)); vals.push(assigned_to); }
      if (!sets.length) return res.status(400).json({ error: 'Sin campos' });
      sets.push("updated_at = NOW()");
      vals.push(req.params.itemId);
      await pool.query(
        `UPDATE production_order_items SET ${sets.join(', ')} WHERE id = $${vals.length} AND deleted_at IS NULL`,
        vals
      );
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/plugins/produccion/history/:orderId', authenticate, checkPlugin, async (req, res) => {
    try {
      const items = await pool.query(
        `SELECT poi.*, ps.name as current_stage
         FROM production_order_items poi
         JOIN production_stages ps ON poi.current_stage_id = ps.id
         WHERE poi.order_id = $1 AND poi.deleted_at IS NULL ORDER BY poi.id`,
        [req.params.orderId]
      );
      if (!items.rows.length) return res.json({ items: [], logs: [] });

      const logs = await pool.query(
        `SELECT pil.*, fs.name as from_stage, ts.name as to_stage, u.name as user_name
         FROM production_item_log pil
         JOIN production_stages fs ON pil.from_stage_id = fs.id
         JOIN production_stages ts ON pil.to_stage_id = ts.id
         LEFT JOIN users u ON pil.created_by = u.id
         WHERE pil.production_item_id = ANY($1::int[])
         ORDER BY pil.created_at DESC`,
        [items.rows.map(i => i.id)]
      );
      res.json({ items: items.rows, logs: logs.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  console.log('Plugin produccion cargado');
};
