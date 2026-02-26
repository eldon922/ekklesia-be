const express = require('express');
const router = express.Router();
const pool = require('../db');
const bcrypt = require('bcryptjs');
const { body, param, validationResult } = require('express-validator');

// Helper: strip password_hash from response
function sanitize(event) {
  const { password_hash, ...safe } = event;
  return { ...safe, is_protected: !!password_hash };
}

// GET all events
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        e.id, e.name, e.description, e.date, e.time, e.location,
        e.created_at, e.updated_at,
        CASE WHEN e.password_hash IS NOT NULL THEN TRUE ELSE FALSE END AS is_protected,
        COUNT(a.id)::int AS total_attendees,
        COUNT(CASE WHEN a.checked_in THEN 1 END)::int AS checked_in_count
      FROM events e
      LEFT JOIN attendees a ON a.event_id = e.id
      GROUP BY e.id
      ORDER BY e.created_at DESC
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET single event
router.get('/:id', param('id').isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    const event = await pool.query('SELECT * FROM events WHERE id = $1', [req.params.id]);
    if (event.rows.length === 0) return res.status(404).json({ success: false, message: 'Event not found' });

    const stats = await pool.query(`
      SELECT COUNT(id)::int AS total_attendees, COUNT(CASE WHEN checked_in THEN 1 END)::int AS checked_in_count
      FROM attendees WHERE event_id = $1
    `, [req.params.id]);

    res.json({ success: true, data: { ...sanitize(event.rows[0]), ...stats.rows[0] } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST verify password for a protected event
router.post('/:id/verify-password', param('id').isInt(), async (req, res) => {
  const { password } = req.body;
  try {
    const result = await pool.query('SELECT password_hash FROM events WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Event not found' });

    const { password_hash } = result.rows[0];
    if (!password_hash) return res.json({ success: true, message: 'No password required' });
    if (!password) return res.status(401).json({ success: false, message: 'Password required' });

    const match = await bcrypt.compare(password, password_hash);
    if (!match) return res.status(401).json({ success: false, message: 'Incorrect password' });

    res.json({ success: true, message: 'Password accepted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST create event — only name required
router.post('/',
  body('name').notEmpty().trim().withMessage('Event name is required'),
  body('date').optional({ checkFalsy: true }).isDate(),
  body('time').optional({ checkFalsy: true }),
  body('location').optional({ checkFalsy: true }).trim(),
  body('description').optional({ checkFalsy: true }).trim(),
  body('password').optional({ checkFalsy: true }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const { name, date, time, location, description, password } = req.body;
    try {
      let password_hash = null;
      if (password && password.trim()) {
        password_hash = await bcrypt.hash(password.trim(), 10);
      }

      const result = await pool.query(
        `INSERT INTO events (name, date, time, location, description, password_hash)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [name, date || null, time || null, location || null, description || null, password_hash]
      );
      res.status(201).json({ success: true, data: sanitize(result.rows[0]) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }
);

// PUT update event
router.put('/:id',
  param('id').isInt(),
  body('name').notEmpty().trim().withMessage('Event name is required'),
  body('date').optional({ checkFalsy: true }).isDate(),
  body('password').optional({ checkFalsy: true }),
  body('remove_password').optional().isBoolean(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const { name, date, time, location, description, password, remove_password } = req.body;
    try {
      // Fetch current hash
      const current = await pool.query('SELECT password_hash FROM events WHERE id = $1', [req.params.id]);
      if (current.rows.length === 0) return res.status(404).json({ success: false, message: 'Event not found' });

      let password_hash = current.rows[0].password_hash;
      if (remove_password) {
        password_hash = null;
      } else if (password && password.trim()) {
        password_hash = await bcrypt.hash(password.trim(), 10);
      }

      const result = await pool.query(
        `UPDATE events SET name=$1, date=$2, time=$3, location=$4, description=$5, password_hash=$6, updated_at=NOW()
         WHERE id=$7 RETURNING *`,
        [name, date || null, time || null, location || null, description || null, password_hash, req.params.id]
      );
      res.json({ success: true, data: sanitize(result.rows[0]) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }
);

// DELETE event
router.delete('/:id', param('id').isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    const result = await pool.query('DELETE FROM events WHERE id=$1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Event not found' });
    res.json({ success: true, message: 'Event deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
