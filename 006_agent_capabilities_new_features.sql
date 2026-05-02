-- Nuevas capacidades Baver 2026-05-01

INSERT INTO agent_capabilities (client_id, capability, description, endpoint, method, category, description_detailed, usage_guide, params, is_active)
VALUES
(1, 'get_dashboard_owner_stats', 'GET /api/dashboard/owner-stats', '/api/dashboard/owner-stats', 'GET', 'dashboard',
 'Obtener estadísticas completas del negocio: ingresos, gastos, neto, compras, ventas, entregas, diseños, clientes nuevos, ticket promedio, top productos y ventas por hora.',
 'Usar para responder consultas de performance del negocio. Params: period=today|week|month|custom. Si period=custom, enviar from=YYYY-MM-DD y to=YYYY-MM-DD.',
 '{"period":"today|week|month|custom","from":"YYYY-MM-DD opcional","to":"YYYY-MM-DD opcional"}'::jsonb, true),

(1, 'get_expense_categories', 'GET /api/expense-categories', '/api/expense-categories', 'GET', 'expenses',
 'Listar categorías de gastos configuradas en Parámetros.',
 'Usar antes de crear un gasto para elegir category_id. Devuelve categorías como Alquileres, Servicios, Sueldos, Marketing, Impuestos, etc.',
 NULL, true),
(1, 'post_expense_categories', 'POST /api/expense-categories', '/api/expense-categories', 'POST', 'expenses',
 'Crear una categoría de gasto.',
 'Solo usar si el admin pide crear una nueva categoría de gasto. Requiere name. Opcional sort_order, is_active.',
 '{"name":"Alquileres","sort_order":1,"is_active":true}'::jsonb, true),
(1, 'put_expense_categories_by_id', 'PUT /api/expense-categories/:id', '/api/expense-categories/:id', 'PUT', 'expenses',
 'Actualizar categoría de gasto.',
 'Solo admin. Permite cambiar name, sort_order, is_active.',
 '{"name":"Servicios","sort_order":2,"is_active":true}'::jsonb, true),
(1, 'delete_expense_categories_by_id', 'DELETE /api/expense-categories/:id', '/api/expense-categories/:id', 'DELETE', 'expenses',
 'Eliminar categoría de gasto mediante soft delete.',
 'Solo admin. Evitar si hay dudas; confirmar antes.',
 NULL, true),

(1, 'get_expenses', 'GET /api/expenses', '/api/expenses', 'GET', 'expenses',
 'Listar gastos/devengamientos no inventariables, con categoría, proveedor, estado de pago, saldo pagado y pendiente.',
 'Usar para consultar gastos. Params: period=today|week|month|all|custom. Para custom usar from y to. Los gastos con payment_pending > 0 son pendientes de pago.',
 '{"period":"today|week|month|all|custom","from":"YYYY-MM-DD opcional","to":"YYYY-MM-DD opcional"}'::jsonb, true),
(1, 'post_expenses', 'POST /api/expenses', '/api/expenses', 'POST', 'expenses',
 'Crear un gasto/devengamiento no inventariable, como alquiler, servicio, impuesto, sueldo, marketing u otro gasto del negocio.',
 'Usar cuando el admin pida cargar un gasto. Requiere description y total. Opcional: category_id, provider_id, issue_date, due_date, notes. No paga automáticamente: solo registra la obligación.',
 '{"category_id":1,"provider_id":null,"description":"Alquiler local mayo","issue_date":"YYYY-MM-DD","due_date":"YYYY-MM-DD","total":100000,"notes":"opcional"}'::jsonb, true),
(1, 'put_expenses_by_id', 'PUT /api/expenses/:id', '/api/expenses/:id', 'PUT', 'expenses',
 'Editar un gasto existente.',
 'Usar para corregir categoría, proveedor, descripción, fechas, monto o notas de un gasto. Si cambia total, el backend recalcula estado de pago.',
 '{"category_id":1,"provider_id":null,"description":"Alquiler local","issue_date":"YYYY-MM-DD","due_date":"YYYY-MM-DD","total":100000,"notes":"opcional"}'::jsonb, true),
(1, 'post_expenses_by_id_payments', 'POST /api/expenses/:id/payments', '/api/expenses/:id/payments', 'POST', 'expenses',
 'Registrar pago directo de un gasto desde caja.',
 'Usar cuando el admin pida pagar un gasto específico. Requiere caja abierta y agente con cash_user_id. Requiere financial_account_id y amount. Actualiza estado del gasto a pagado/parcial según saldo.',
 '{"financial_account_id":1,"amount":44000,"notes":"Pago gasto"}'::jsonb, true),
(1, 'delete_expenses_by_id', 'DELETE /api/expenses/:id', '/api/expenses/:id', 'DELETE', 'expenses',
 'Eliminar un gasto mediante soft delete.',
 'Confirmar antes de eliminar. No usar para anular pagos; para pagos usar eliminación de cash movement si corresponde.',
 NULL, true),

(1, 'post_cash_movements_expense_payment', 'POST /api/cash-movements para pago de gasto', '/api/cash-movements', 'POST', 'cash',
 'Registrar un egreso de caja imputado a un gasto existente usando reason=expense_payment y expense_id.',
 'Usar desde el flujo general de pagos cuando el admin diga pagar un gasto. Requiere caja abierta, financial_account_id, type=out, reason=expense_payment, expense_id y amount. Actualiza saldo/estado del gasto.',
 '{"financial_account_id":1,"type":"out","reason":"expense_payment","expense_id":10,"amount":44000,"notes":"Pago gasto"}'::jsonb, true),

(1, 'configure_agent_cash_user', 'PUT /api/agents/:id cash_user_id', '/api/agents/:id', 'PUT', 'agents',
 'Configurar el usuario de caja efectivo de un agente IA.',
 'Usar si el admin pide vincular un agente a un usuario de caja. Enviar cash_user_id con id de users. Si se elimina el usuario, queda null por FK ON DELETE SET NULL.',
 '{"cash_user_id":11}'::jsonb, true)
ON CONFLICT (client_id, capability) DO UPDATE SET
  description = EXCLUDED.description,
  endpoint = EXCLUDED.endpoint,
  method = EXCLUDED.method,
  category = EXCLUDED.category,
  description_detailed = EXCLUDED.description_detailed,
  usage_guide = EXCLUDED.usage_guide,
  params = EXCLUDED.params,
  is_active = true;

UPDATE agent_capabilities
SET description_detailed = 'Crear una nueva venta / Nota de Venta. Al crear la NV descuenta stock dentro de una transacción; no espera a marcar entregado. El estado inicial depende del canal: si sale_channels.immediate_delivery=true nace Entregado; si no, nace Pendiente/primer estado.',
    usage_guide = 'Usar cuando un cliente quiera comprar o el admin pida cargar una venta. Requiere contact_id e items[{product_id, quantity, unit_price, product_name opcional, attribute_value_id opcional}]. Opcional: sale_channel_id, payment_method_id, delivery, advance_id/advance_amount, effective_cash_amount. Si se cobra en el acto requiere caja abierta.'
WHERE client_id=1 AND capability='post_orders';

UPDATE agent_capabilities
SET description_detailed = 'Actualizar canal de venta. Además de has_delivery, existe immediate_delivery: si true, las NV nacen Entregado; si false, nacen Pendiente/primer estado.',
    usage_guide = 'Solo admin. Usar immediate_delivery=true para Mostrador/Local; false para Digital u otros canales que deben quedar pendientes hasta entrega. has_delivery controla si genera entrega automática/logística.'
WHERE client_id=1 AND capability='put_sale_channels_by_id';

UPDATE agent_capabilities
SET description_detailed = 'Registrar movimiento de caja: cobro (in) o pago (out). Puede asociarse a NV, NP, proveedor, cliente o gasto.',
    usage_guide = 'Para cobrar NV: type=in, reason=nv_payment o sale, order_id, amount, financial_account_id. Para pagar NP: type=out, reason=np_payment, purchase_order_id. Para pagar gasto: type=out, reason=expense_payment, expense_id. Requiere caja abierta; agentes usan agents.cash_user_id como usuario efectivo de caja.'
WHERE client_id=1 AND capability='post_cash_movements';

UPDATE agent_capabilities
SET description_detailed = COALESCE(description_detailed,'') || ' El agente puede operar caja si tiene agents.cash_user_id vinculado; current debe devolver my_user_id del usuario efectivo.',
    usage_guide = COALESCE(usage_guide,'') || ' Si falla por usuario de caja, revisar cash_user_id del agente en Mis Agentes.'
WHERE client_id=1 AND capability='get_cash_sessions_current';
