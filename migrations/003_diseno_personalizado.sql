-- Migration 2026-05-03: diseño personalizado + capabilities

-- 1. Instrucciones permanentes de diseño personalizado
INSERT INTO agent_instructions (agent_id, type, content, sort_order, is_active)
VALUES
(1, 'permanent', 'DISEÑO PERSONALIZADO - CAMISETAS: cuando el lead pida una camiseta (Manga Corta Femenino, Manga Ranglan, o cualquier producto que requiera personalización), informar que el diseño es 100% personalizado. El cliente elige modelo, color y estilo a gusto. NO vender como producto de catálogo cerrado. El flujo es: 1) Cliente pide camiseta 2) Consultar modelo aproximado (corte, color, manga) 3) Crear NV con los specs conversados 4) Una vez señalda la NV, crear Design Request desde el dashboard 5) Guiar al cliente a que comparta referencias/dibujo/ideas de diseño por el mismo chat 6) El diseñador de Baver toma esos datos, hace el render final con logos/sponsors y lo sube al dashboard. Castorcito NO maneja el render ni los detalles de producción. El módulo de diseño (templates, renders, aprobación) se gestiona desde el dashboard de Baver.', -13, true),
(1, 'permanent', 'POST-SEÑA: después de que el cliente haya señaldo la NV de una camiseta personalizada, explicarle que el siguiente paso es el diseño. Decirle que puede compartir referencias, dibujos, fotos de ejemplo, colores, logos, números, nombres que quiera que lleve la camiseta. También puede pedir un boceto. Registrar todos los datos de diseño en las notes de la NV. El render final lo realiza el equipo de Baver desde el dashboard.', -12, true);

-- 2. Nuevos procedimientos lead_personalizado
INSERT INTO agent_procedures (agent_id, context, step_order, step_name, step_prompt, active)
VALUES
(1, 'lead_personalizado', 0, 'Recibir referencias de diseño', 'El cliente ya señaló su camiseta personalizada. Preguntarle si tiene referencias de diseño: fotos, dibujos, colores, logos, números, nombres. Preguntar: - Color/es principal/es - Número de camiseta (si aplica) - Nombre o apodo (si aplica) - Logos o escudos (si aplica) - Sponsors (si aplica, y si tiene alguno) - Alguna foto de referencia de cómo lo imagina. Decirle que todo se puede ir agregando. El diseñador de Baver va a tomar esos datos para hacer el boceto.', true),
(1, 'lead_personalizado', 1, 'Documentar en notes', 'Registrar todos los datos de diseño que compartió el cliente en las notes de la NV asociada. Usar PUT /api/orders/:id con body {notes: "[datos de diseño actualizados]"}. Luego avisar al cliente que los datos quedaron registrados y que el equipo de Baver va a trabajar en el diseño.', true),
(1, 'lead_personalizado', 2, 'Cierre de guía de diseño', 'Agradecer al cliente por compartir sus ideas. Explicar que el equipo de diseño va a preparar un boceto y que será notificado cuando esté listo (lo pueden ver desde el dashboard). Si el cliente quiere hacer cambios después, puede consultar de nuevo por este chat. Mantener tono cálido y entusiasta.', true);

-- 3. Modificar lead_nuevo pasos 5 y 6
UPDATE agent_procedures SET step_prompt = 'Preguntar si quiere comprar el producto elegido. Confirmar: producto exacto, talle, cantidad, color. Preguntar método de pago (transferencia/efectivo/débito/crédito).

DETECCIÓN DE DISEÑO PERSONALIZADO: SI el producto es una camiseta (Manga Corta Femenino, Manga Ranglan) o el cliente pide personalización, informar que EL DISEÑO ES 100% PERSONALIZADO. El cliente elige el modelo que más le guste y se fabrica a medida. Explicar que: - El diseño se trabaja en conjunto con Baver - Después de señar la NV, van a coordinar el diseño por este mismo chat - El cliente puede compartir referencias, fotos, dibujos, colores, logos que quiera - Baver prepara un boceto render y luego el diseñador agrega logos/sponsors/detalles de producción

Crear orden en estado pendiente. Si es camiseta personalizada, incluir en notes del pedido: "DISEÑO PERSONALIZADO - requiere coordinación post-seña". NO hacer render ni diseño en este paso. Solo registrar la venta y avisar que el diseño viene después de la seña.', updated_at = NOW() WHERE id = 7;

UPDATE agent_procedures SET step_prompt = 'Agradecer la compra. Dar número de orden. SI ES CAMISETA PERSONALIZADA: avisar que el diseño se coordina después de la seña. Decirle: "apenas confirmes la seña coordinamos el diseño de tu camiseta. Mandame una foto, dibujo o idea de cómo la querés y nosotros la plasmamos". SI NO ES PERSONALIZADA: Preguntar si necesita algo más. Si no compró, preguntar si quiere que le avisen cuando haya novedades. Registrar un outbound en lead_interactions con direction=outbound, message_type=conversion y resumen de lo acordado.', updated_at = NOW() WHERE agent_id = 1 AND context = 'lead_nuevo' AND step_order = 6;

-- 4. Nuevas capabilities (design + agents + sales)
INSERT INTO agent_capabilities (client_id, capability, method, endpoint, description, params, category, is_active) VALUES
(1, 'get_pending_design_orders', 'GET', '/api/design-requests/pending-orders', 'Obtener NV pendientes de diseño (ordenes pagadas sin design request)', '{}', 'design', true),
(1, 'get_entity_designs', 'GET', '/api/entity-designs', 'Obtener templates de diseño de una entidad (club). Filtra por ?entity_id=', '{"entity_id": "integer (opcional)"}', 'design', true),
(1, 'post_entity_designs', 'POST', '/api/entity-designs', 'Crear template de diseño para una entidad. Body: {entity_id, name, template_url}', '{"entity_id": "integer", "name": "string", "template_url": "string"}', 'design', true),
(1, 'delete_entity_designs', 'DELETE', '/api/entity-designs/:id', 'Eliminar template de diseño de entidad', '{}', 'design', true),
(1, 'post_entity_designs_upload', 'POST', '/api/entity-designs/upload', 'Subir archivo de template de diseño (multipart/form-data)', '{}', 'design', true),
(1, 'get_design_request_items', 'GET', '/api/design-requests/:id/items', 'Obtener items de un pedido de diseño', '{}', 'design', true),
(1, 'get_public_design_request', 'GET', '/api/design-requests/public/:token', 'Obtener design request por token público (para cliente)', '{}', 'design', true),
(1, 'get_public_design_request_items', 'GET', '/api/design-requests/public/:token/items', 'Obtener items de DR por token público', '{}', 'design', true),
(1, 'post_public_design_render', 'POST', '/api/design-requests/public/:token/render', 'Renderizar diseño desde link público del cliente. Body: {image_url}', '{"image_url": "string"}', 'design', true),
(1, 'get_entity_design_requests', 'GET', '/api/entities/:id/designs', 'Obtener design requests de una entidad', '{}', 'design', true),
(1, 'get_agent_procedures', 'GET', '/api/agent-procedures', 'Obtener procedimientos de un agente. Filtra por ?agent_id=', '{"agent_id": "integer (opcional)"}', 'agents', true),
(1, 'post_agent_procedures', 'POST', '/api/agent-procedures', 'Crear procedimiento para un agente. Body: {agent_id, context, step_order, step_name, step_prompt}', '{"agent_id": "integer", "context": "string", "step_order": "integer", "step_name": "string", "step_prompt": "string"}', 'agents', true),
(1, 'put_agent_procedures', 'PUT', '/api/agent-procedures/:id', 'Actualizar procedimiento de agente', '{"step_prompt": "string", "step_order": "integer", "step_name": "string", "context": "string"}', 'agents', true),
(1, 'put_agent_procedures_reorder', 'PUT', '/api/agent-procedures/reorder', 'Reordenar procedimientos. Body: [{id, step_order}]', '{}', 'agents', true),
(1, 'delete_agent_procedures', 'DELETE', '/api/agent-procedures/:id', 'Eliminar procedimiento de agente', '{}', 'agents', true),
(1, 'put_orders_notes', 'PUT', '/api/orders/:id', 'Actualizar notas de una orden (usar para documentar datos de diseño personalizado)', '{"notes": "string"}', 'sales', true);
