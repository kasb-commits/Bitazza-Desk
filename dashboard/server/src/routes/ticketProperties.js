// /api/ticket-properties — dynamic ticket property engine
const router = require('express').Router();
const pool   = require('../db/pg');
const { authenticate, requirePermission } = require('../middleware/auth');

// ── GET /definitions ─────────────────────────────────────────────────────────
// Returns all property definitions. ?include_inactive=true for admin view.
router.get('/definitions', authenticate, async (req, res) => {
  try {
    const includeInactive = req.query.include_inactive === 'true';
    const { rows } = await pool.query(
      `SELECT id, name, field_key, field_type, options, applies_to,
              is_required, is_active, display_order, created_at, updated_at
         FROM ticket_property_definitions
        ${includeInactive ? '' : 'WHERE is_active = true'}
        ORDER BY display_order ASC, created_at ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('[ticketProperties] GET /definitions error:', err);
    res.status(500).json({ error: 'Failed to load property definitions' });
  }
});

// ── POST /definitions ─────────────────────────────────────────────────────────
// Create a new property definition. Requires admin.ticket_properties.
router.post('/definitions', authenticate, requirePermission('admin.ticket_properties'), async (req, res) => {
  const { name, field_key, field_type, options, applies_to, is_required, display_order } = req.body;
  if (!name || !field_key || !field_type) {
    return res.status(400).json({ error: 'name, field_key, and field_type are required' });
  }
  const VALID_TYPES = ['single_select', 'multi_select', 'text', 'number', 'boolean'];
  if (!VALID_TYPES.includes(field_type)) {
    return res.status(400).json({ error: `field_type must be one of: ${VALID_TYPES.join(', ')}` });
  }
  // Validate field_key format: lowercase, alphanumeric + underscores only
  if (!/^[a-z0-9_]+$/.test(field_key)) {
    return res.status(400).json({ error: 'field_key must be lowercase alphanumeric with underscores only' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO ticket_property_definitions
         (name, field_key, field_type, options, applies_to, is_required, display_order, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        name,
        field_key,
        field_type,
        options ? JSON.stringify(options) : null,
        applies_to?.length ? applies_to : null,
        is_required ?? false,
        display_order ?? 0,
        req.user.id,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A property with that field_key already exists' });
    }
    console.error('[ticketProperties] POST /definitions error:', err);
    res.status(500).json({ error: 'Failed to create property definition' });
  }
});

// ── PATCH /definitions/:id ────────────────────────────────────────────────────
// Update an existing definition. Requires admin.ticket_properties.
router.patch('/definitions/:id', authenticate, requirePermission('admin.ticket_properties'), async (req, res) => {
  const { id } = req.params;
  const allowed = ['name', 'options', 'applies_to', 'is_required', 'is_active', 'display_order'];
  const updates = [];
  const values  = [];
  let idx = 1;

  for (const field of allowed) {
    if (req.body[field] !== undefined) {
      if (field === 'options') {
        updates.push(`options = $${idx++}`);
        values.push(req.body[field] ? JSON.stringify(req.body[field]) : null);
      } else if (field === 'applies_to') {
        updates.push(`applies_to = $${idx++}`);
        values.push(req.body[field]?.length ? req.body[field] : null);
      } else {
        updates.push(`${field} = $${idx++}`);
        values.push(req.body[field]);
      }
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No updatable fields provided' });
  }

  values.push(id);
  try {
    const { rows } = await pool.query(
      `UPDATE ticket_property_definitions SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Property definition not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[ticketProperties] PATCH /definitions/:id error:', err);
    res.status(500).json({ error: 'Failed to update property definition' });
  }
});

// ── DELETE /definitions/:id ───────────────────────────────────────────────────
// Hard-delete if no ticket values reference this property.
// Soft-deactivate (is_active=false) if values exist.
router.delete('/definitions/:id', authenticate, requirePermission('admin.ticket_properties'), async (req, res) => {
  const { id } = req.params;
  try {
    const { rows: defRows } = await pool.query(
      'SELECT id FROM ticket_property_definitions WHERE id = $1', [id]
    );
    if (defRows.length === 0) return res.status(404).json({ error: 'Property definition not found' });

    const { rows: valRows } = await pool.query(
      'SELECT 1 FROM ticket_property_values WHERE property_id = $1 LIMIT 1', [id]
    );

    if (valRows.length > 0) {
      // Has existing values — soft-deactivate
      await pool.query(
        'UPDATE ticket_property_definitions SET is_active = false WHERE id = $1', [id]
      );
      return res.json({ deleted: false, deactivated: true, message: 'Property has existing values — deactivated instead of deleted' });
    }

    await pool.query('DELETE FROM ticket_property_definitions WHERE id = $1', [id]);
    res.json({ deleted: true, deactivated: false });
  } catch (err) {
    console.error('[ticketProperties] DELETE /definitions/:id error:', err);
    res.status(500).json({ error: 'Failed to delete property definition' });
  }
});

// ── GET /tickets/:ticketId/values ─────────────────────────────────────────────
// Returns all property values for a ticket as a map: { [property_id]: value_obj }
router.get('/tickets/:ticketId/values', authenticate, async (req, res) => {
  const { ticketId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT v.property_id, v.value_text, v.value_array, v.value_number, v.updated_at,
              u.name AS updated_by_name
         FROM ticket_property_values v
    LEFT JOIN users u ON u.id = v.updated_by
        WHERE v.ticket_id = $1`,
      [ticketId]
    );
    // Return as map keyed by property_id for O(1) lookup in frontend
    const map = {};
    for (const row of rows) {
      map[row.property_id] = {
        value_text:      row.value_text,
        value_array:     row.value_array,
        value_number:    row.value_number,
        updated_at:      row.updated_at,
        updated_by_name: row.updated_by_name,
      };
    }
    res.json(map);
  } catch (err) {
    console.error('[ticketProperties] GET /tickets/:ticketId/values error:', err);
    res.status(500).json({ error: 'Failed to load property values' });
  }
});

// ── PATCH /tickets/:ticketId/values ──────────────────────────────────────────
// Upsert one property value for a ticket.
// Body: { property_id, value } where value type depends on field_type.
router.patch('/tickets/:ticketId/values', authenticate, async (req, res) => {
  const { ticketId } = req.params;
  const { property_id, value } = req.body;

  if (!property_id) return res.status(400).json({ error: 'property_id is required' });

  try {
    // Look up the definition to determine the correct column
    const { rows: defRows } = await pool.query(
      'SELECT field_type FROM ticket_property_definitions WHERE id = $1 AND is_active = true',
      [property_id]
    );
    if (defRows.length === 0) {
      return res.status(404).json({ error: 'Property definition not found or inactive' });
    }

    const { field_type } = defRows[0];

    let valueText   = null;
    let valueArray  = null;
    let valueNumber = null;

    if (value === null || value === undefined || value === '') {
      // Clear the value — nulls all columns
    } else if (field_type === 'text' || field_type === 'single_select' || field_type === 'boolean') {
      valueText = String(value);
    } else if (field_type === 'multi_select') {
      valueArray = Array.isArray(value) ? value : [String(value)];
    } else if (field_type === 'number') {
      valueNumber = Number(value);
      if (isNaN(valueNumber)) return res.status(400).json({ error: 'value must be a number' });
    }

    const { rows } = await pool.query(
      `INSERT INTO ticket_property_values (ticket_id, property_id, value_text, value_array, value_number, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (ticket_id, property_id) DO UPDATE SET
         value_text   = EXCLUDED.value_text,
         value_array  = EXCLUDED.value_array,
         value_number = EXCLUDED.value_number,
         updated_by   = EXCLUDED.updated_by,
         updated_at   = NOW()
       RETURNING *`,
      [ticketId, property_id, valueText, valueArray, valueNumber, req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[ticketProperties] PATCH /tickets/:ticketId/values error:', err);
    res.status(500).json({ error: 'Failed to save property value' });
  }
});

module.exports = router;
