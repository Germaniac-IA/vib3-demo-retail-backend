// Plugin: Fabricación
// Convierte insumos en productos terminados según la receta definida en product_input_components
// Se activa con un flag en clients

module.exports = function(app, pool, authenticate) {

  async function pluginEnabled(clientId) {
    const { rows } = await pool.query(
      "SELECT plugins FROM clients WHERE id = $1 AND deleted_at IS NULL",
      [clientId]
    );
    if (!rows[0]) return false;
    const plugins = rows[0].plugins || [];
    return plugins.includes('fabricacion');
  }

  // GET /api/plugins/fabricacion/check
  app.get('/api/plugins/fabricacion/check', authenticate, async (req, res) => {
    const enabled = await pluginEnabled(req.user.client_id);
    res.json({ enabled });
  });

  // GET /api/plugins/fabricacion/recipe/:productId
  app.get('/api/plugins/fabricacion/recipe/:productId', authenticate, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT pic.id, pic.quantity, pic.input_item_id,
               ii.name as input_name, ii.unit, ii.stock_quantity as input_stock,
               ii.requires_stock
        FROM product_input_components pic
        JOIN input_items ii ON pic.input_item_id = ii.id
        WHERE pic.product_id = $1 AND pic.deleted_at IS NULL
        ORDER BY pic.id
      `, [req.params.productId]);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/plugins/fabricacion/check-inputs/:productId/:quantity
  app.get('/api/plugins/fabricacion/check-inputs/:productId/:quantity', authenticate, async (req, res) => {
    try {
      const productId = parseInt(req.params.productId);
      const quantity = parseInt(req.params.quantity);
      if (!quantity || quantity <= 0) return res.status(400).json({ error: 'Cantidad inválida' });

      const { rows: recipe } = await pool.query(`
        SELECT pic.quantity, pic.input_item_id, ii.name as input_name, ii.unit,
               ii.stock_quantity as input_stock, ii.requires_stock
        FROM product_input_components pic
        JOIN input_items ii ON pic.input_item_id = ii.id
        WHERE pic.product_id = $1 AND pic.deleted_at IS NULL
      `, [productId]);

      const details = recipe.map(item => {
        const needed = Number(item.quantity) * quantity;
        return {
          input_name: item.input_name,
          unit: item.unit,
          needed: needed,
          available: item.requires_stock ? Number(item.input_stock) || 0 : null,
          requires_stock: item.requires_stock,
          sufficient: item.requires_stock ? (Number(item.input_stock) || 0) >= needed : true
        };
      });

      const stockErrors = details.filter(d => d.requires_stock && !d.sufficient);
      res.json({
        can_manufacture: stockErrors.length === 0,
        product_id: productId,
        quantity: quantity,
        inputs: details,
        errors: stockErrors.map(d => d.input_name + ': necesitás ' + d.needed + ' ' + (d.unit || 'unidades') + ', tenés ' + d.available)
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/plugins/fabricacion/manufacture
  app.post('/api/plugins/fabricacion/manufacture', authenticate, async (req, res) => {
    const client = await pool.connect();
    try {
      const { product_id, quantity, order_id, notes } = req.body;

      if (!product_id || !quantity || quantity <= 0) {
        return res.status(400).json({ error: 'product_id y quantity son requeridos' });
      }

      if (!(await pluginEnabled(req.user.client_id))) {
        return res.status(404).json({ error: 'Plugin no disponible' });
      }

      const { rows: recipe } = await pool.query(`
        SELECT pic.quantity, pic.input_item_id, ii.name as input_name,
               ii.stock_quantity as input_stock, ii.requires_stock
        FROM product_input_components pic
        JOIN input_items ii ON pic.input_item_id = ii.id
        WHERE pic.product_id = $1 AND pic.deleted_at IS NULL
      `, [product_id]);

      if (recipe.length === 0) {
        return res.status(400).json({ error: 'El producto no tiene receta de fabricación' });
      }

      await client.query('BEGIN');

      // Validar solo insumos que requieren stock
      const stockErrors = [];
      for (const item of recipe) {
        if (item.requires_stock) {
          const needed = Number(item.quantity) * quantity;
          const available = Number(item.input_stock) || 0;
          if (available < needed) {
            stockErrors.push(item.input_name + ': necesitás ' + needed + ' ' + (item.unit || 'unidades') + ', tenés ' + available);
          }
        }
      }

      if (stockErrors.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Stock insuficiente', details: stockErrors });
      }

      // Descontar solo insumos que requieren stock
      for (const item of recipe) {
        if (item.requires_stock) {
          const needed = Number(item.quantity) * quantity;
          const sql = 'UPDATE input_items SET stock_quantity = GREATEST(0, COALESCE(stock_quantity, 0) - $1) WHERE id = $2';
          await client.query(sql, [needed, item.input_item_id]);
        }
      }

      // Aumentar stock del producto terminado
      const prodSql = 'UPDATE products SET stock_quantity = COALESCE(stock_quantity, 0) + $1 WHERE id = $2 AND client_id = $3';
      await client.query(prodSql, [quantity, product_id, req.user.client_id]);

      // Registrar movimiento
      const { rows: mov } = await client.query(`
        INSERT INTO manufacturing_movements (client_id, product_id, quantity, order_id, notes, created_by)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
      `, [req.user.client_id, product_id, quantity, order_id || null, notes || null, req.user.id]);

      await client.query('COMMIT');

      const { rows: product } = await client.query(
        'SELECT id, name, stock_quantity FROM products WHERE id = $1',
        [product_id]
      );

      res.status(201).json({
        movement: mov[0],
        product: product[0],
        message: 'Se fabricaron ' + quantity + ' unidades de ' + (product[0]?.name || 'producto')
      });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // GET /api/plugins/fabricacion/movements
  app.get('/api/plugins/fabricacion/movements', authenticate, async (req, res) => {
    try {
      const query = `
        SELECT mm.*, p.name as product_name, u.username as created_by_name
        FROM manufacturing_movements mm
        JOIN products p ON mm.product_id = p.id
        LEFT JOIN users u ON mm.created_by = u.id
        WHERE mm.client_id = $1 AND mm.deleted_at IS NULL
        ORDER BY mm.created_at DESC
        LIMIT ` + (req.query.limit || 50) + `
      `;
      const { rows } = await pool.query(query, [req.user.client_id]);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/plugins/fabricacion/movements/:id
  // Soft-delete: restituye los insumos descontados y descuenta el producto fabricado
  app.delete('/api/plugins/fabricacion/movements/:id', authenticate, async (req, res) => {
    const client = await pool.connect();
    try {
      const movementId = parseInt(req.params.id);

      // Obtener el movimiento
      const { rows: mov } = await client.query(
        'SELECT * FROM manufacturing_movements WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL',
        [movementId, req.user.client_id]
      );

      if (mov.length === 0) {
        return res.status(404).json({ error: 'Movimiento no encontrado o ya fue eliminado' });
      }

      const m = mov[0];

      // Obtener la receta del producto para saber qué insumos se usaron
      const { rows: recipe } = await client.query(`
        SELECT pic.quantity, pic.input_item_id, ii.name as input_name, ii.requires_stock
        FROM product_input_components pic
        JOIN input_items ii ON pic.input_item_id = ii.id
        WHERE pic.product_id = $1 AND pic.deleted_at IS NULL
      `, [m.product_id]);

      await client.query('BEGIN');

      // Restituir insumos (devolver stock a los que requieren stock)
      for (const item of recipe) {
        if (item.requires_stock) {
          const qty = Number(item.quantity) * Number(m.quantity);
          await client.query(
            'UPDATE input_items SET stock_quantity = COALESCE(stock_quantity, 0) + $1 WHERE id = $2',
            [qty, item.input_item_id]
          );
        }
      }

      // Descontar stock del producto fabricado
      await client.query(
        'UPDATE products SET stock_quantity = GREATEST(0, COALESCE(stock_quantity, 0) - $1) WHERE id = $2 AND client_id = $3',
        [Number(m.quantity), m.product_id, req.user.client_id]
      );

      // Soft-delete del movimiento
      await client.query(
        'UPDATE manufacturing_movements SET deleted_at = NOW() WHERE id = $1',
        [movementId]
      );

      await client.query('COMMIT');

      const { rows: product } = await client.query(
        'SELECT id, name, stock_quantity FROM products WHERE id = $1',
        [m.product_id]
      );

      res.json({
        message: 'Movimiento anulado. Se restituyeron los insumos y se descontaron ' + m.quantity + ' unidades de ' + (product[0]?.name || 'producto'),
        product: product[0]
      });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });
};
