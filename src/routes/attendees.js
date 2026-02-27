const express = require("express");
const router = express.Router({ mergeParams: true });
const pool = require("../db");
const multer = require("multer");
const XLSX = require("xlsx");
const { body, param, validationResult } = require("express-validator");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Helper: get event stats
async function getEventStats(eventId) {
  const res = await pool.query(
    `
    SELECT
      COUNT(id)::int AS total_attendees,
      COUNT(CASE WHEN checked_in THEN 1 END)::int AS checked_in_count
    FROM attendees WHERE event_id = $1
  `,
    [eventId],
  );
  return res.rows[0];
}

// ─── normalization utilities ───────────────────────────────────────────────
function normalizePhone(number) {
  if (!number) return null;
  // strip everything except digits
  let digits = number.toString().replace(/\D/g, '');
  // simple rule: if number starts with 0 and has more than one digit, you
  // could convert to international form here (e.g. +62 -> 62) depending on
  // your user base. for now we just keep the raw digits so different
  // formatting doesn't prevent a match.
  return digits;
}

function normalizeName(name) {
  if (!name) return '';
  // lowercase and remove non-alphanumeric so "John Doe" == "john doe" ==
  // "john.doe" etc. this is still just exact comparison; for fuzzy matching
  // you'd need a library or additional logic.
  return name.toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}


// Helper: emit to all clients watching this event
function emitToEvent(req, eventId, event, payload) {
  const io = req.app.get("io");
  if (io) io.to(`event:${eventId}`).emit(event, payload);
}

// ─── GET attendees with optional search/filter ───────────────────────────────
router.get("/", async (req, res) => {
  const { eventId } = req.params;
  const { search, checked_in } = req.query;

  try {
    let queryStr = `SELECT * FROM attendees WHERE event_id = $1`;
    const params = [eventId];
    let paramIndex = 2;

    if (search && search.trim()) {
      queryStr += ` AND (LOWER(name) LIKE $${paramIndex} OR phone_number LIKE $${paramIndex + 1})`;
      const s = `%${search.toLowerCase().trim()}%`;
      params.push(s, s);
      paramIndex += 2;
    }

    if (checked_in !== undefined && checked_in !== "") {
      queryStr += ` AND checked_in = $${paramIndex}`;
      params.push(checked_in === "true");
      paramIndex++;
    }

    queryStr += " ORDER BY id ASC";

    const result = await pool.query(queryStr, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── POST create single attendee ─────────────────────────────────────────────
router.post(
  "/",
  body("name").notEmpty().trim(),
  body("phone_number").optional().trim(),
  body("email").optional({ checkFalsy: true }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ success: false, errors: errors.array() });

    const { eventId } = req.params;
    const { name, phone_number, email } = req.body;
    try {
      const result = await pool.query(
        `INSERT INTO attendees (event_id, name, phone_number, email) VALUES ($1, $2, $3, $4) RETURNING *`,
        [eventId, name, phone_number || null, email || null],
      );
      const stats = await getEventStats(eventId);

      // Broadcast: new attendee added
      emitToEvent(req, eventId, "attendee:added", {
        eventId: parseInt(eventId),
        attendee: result.rows[0],
        stats,
      });

      res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// ─── POST import from CSV/Excel ───────────────────────────────────────────────
router.post("/import", upload.single("file"), async (req, res) => {
  const { eventId } = req.params;

  if (!req.file) {
    return res
      .status(400)
      .json({ success: false, message: "No file uploaded" });
  }

  try {
    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    if (rows.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "File is empty or has no data" });
    }

    const nameKeys = [
      "name",
      "full name",
      "fullname",
      "nama",
      "nama lengkap",
      "your name",
      "participant name",
    ];
    const phoneKeys = [
      "phone",
      "phone number",
      "phonenumber",
      "mobile",
      "hp",
      "no hp",
      "no. hp",
      "nomor hp",
      "whatsapp",
      "no telepon",
      "handphone",
    ];
    const emailKeys = ["email", "email address", "emailaddress", "e-mail"];

    const firstRow = rows[0];
    const firstRowKeys = Object.keys(firstRow).map((k) =>
      k.toLowerCase().trim(),
    );

    const findKey = (keys) => {
      for (const k of keys) {
        const found = firstRowKeys.find((fk) => fk === k || fk.includes(k));
        if (found)
          return Object.keys(firstRow).find(
            (ok) =>
              ok.toLowerCase().trim() === found ||
              ok.toLowerCase().trim().includes(k),
          );
      }
      return null;
    };

    const nameKey = findKey(nameKeys);
    const phoneKey = findKey(phoneKeys);
    const emailKey = findKey(emailKeys);

    if (!nameKey) {
      return res.status(400).json({
        success: false,
        message:
          'Could not find a name column. Please ensure your file has a column named "Name" or "Full Name".',
        detected_columns: Object.keys(firstRow),
      });
    }

    const client = await pool.connect();
    let imported = 0;
    let skipped = 0;
    const duplicates = [];

    try {
      await client.query("BEGIN");

      for (const row of rows) {
        const name = row[nameKey]?.toString().trim();
        const phone = phoneKey ? row[phoneKey]?.toString().trim() : null;
        const email = emailKey ? row[emailKey]?.toString().trim() : null;

        if (!name) {
          skipped++;
          continue;
        }

        // Check for duplicates using normalized values to catch common
        // formatting differences (e.g. +62 vs 0812) and simple typos.
        let duplicateMatch = null;

        const normPhone = normalizePhone(phone);
        if (normPhone) {
          // compare against normalized phone numbers in the database using
          // regexp_replace to strip non-digits from stored values as well
          const phoneCheck = await client.query(
            `SELECT id, name, phone_number FROM attendees
             WHERE event_id = $1
               AND regexp_replace(phone_number, '\\D', '', 'g') = $2
             LIMIT 1`,
            [eventId, normPhone],
          );
          if (phoneCheck.rows.length > 0) {
            duplicateMatch = {
              matchedBy: "phone",
              existingPhone: phoneCheck.rows[0].phone_number,
              existingName: phoneCheck.rows[0].name,
            };
          }
        }

        if (!duplicateMatch) {
          const normName = normalizeName(name);
          const nameCheck = await client.query(
            `SELECT id, name, phone_number FROM attendees
             WHERE event_id = $1
               AND regexp_replace(lower(name), '[^a-z0-9]', '', 'g') = $2
             LIMIT 1`,
            [eventId, normName],
          );
          if (nameCheck.rows.length > 0) {
            duplicateMatch = {
              matchedBy: "name",
              existingName: nameCheck.rows[0].name,
              existingPhone: nameCheck.rows[0].phone_number,
            };
          }
        }

        if (duplicateMatch) {
          duplicates.push({
            name,
            phone,
            email,
            rowIndex: rows.indexOf(row) + 2, // +2 because 1-indexed and header is row 1
            matchedBy: duplicateMatch.matchedBy,
            existingName: duplicateMatch.existingName,
            existingPhone: duplicateMatch.existingPhone,
          });
          continue;
        }

        await client.query(
          `INSERT INTO attendees (event_id, name, phone_number, email) VALUES ($1, $2, $3, $4)`,
          [eventId, name, phone || null, email || null],
        );
        imported++;
      }

      await client.query("COMMIT");

      const stats = await getEventStats(eventId);

      // Broadcast: attendee list changed (bulk import)
      emitToEvent(req, eventId, "attendees:imported", {
        eventId: parseInt(eventId),
        imported,
        skipped,
        stats,
      });

      res.json({
        success: true,
        message: `Import complete. ${imported} attendees imported, ${skipped} rows skipped${duplicates.length > 0 ? `, ${duplicates.length} duplicates found` : ""}.`,
        imported,
        skipped,
        duplicates,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({
        success: false,
        message: "Error processing file: " + err.message,
      });
  }
});

// ─── POST import approved duplicates ──────────────────────────────────────────
router.post("/import-duplicates", async (req, res) => {
  const { eventId } = req.params;
  const { duplicates } = req.body;

  if (!duplicates || !Array.isArray(duplicates)) {
    return res.status(400).json({
      success: false,
      message: "No duplicates provided",
    });
  }

  try {
    const client = await pool.connect();
    let imported = 0;

    try {
      await client.query("BEGIN");

      for (const dup of duplicates) {
        const { name, phone, email } = dup;
        if (!name) continue;

        await client.query(
          `INSERT INTO attendees (event_id, name, phone_number, email) VALUES ($1, $2, $3, $4)`,
          [eventId, name, phone || null, email || null],
        );
        imported++;
      }

      await client.query("COMMIT");

      const stats = await getEventStats(eventId);

      // Broadcast: attendee list changed
      emitToEvent(req, eventId, "attendees:imported", {
        eventId: parseInt(eventId),
        imported,
        skipped: 0,
        stats,
      });

      res.json({
        success: true,
        message: `${imported} duplicate attendees imported.`,
        imported,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: "Error importing duplicates: " + err.message,
    });
  }
});

// ─── PATCH check-in ───────────────────────────────────────────────────────────
router.patch(
  "/:attendeeId/checkin",
  param("attendeeId").isInt(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ success: false, errors: errors.array() });

    const { eventId, attendeeId } = req.params;
    try {
      const current = await pool.query(
        "SELECT * FROM attendees WHERE id = $1 AND event_id = $2",
        [attendeeId, eventId],
      );

      if (current.rows.length === 0) {
        return res
          .status(404)
          .json({ success: false, message: "Attendee not found" });
      }

      const attendee = current.rows[0];

      if (attendee.checked_in) {
        return res.status(409).json({
          success: false,
          message: `${attendee.name} is already checked in at ${new Date(attendee.checked_in_at).toLocaleTimeString()}`,
          data: attendee,
        });
      }

      const result = await pool.query(
        `UPDATE attendees SET checked_in = TRUE, checked_in_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND event_id = $2 RETURNING *`,
        [attendeeId, eventId],
      );

      const stats = await getEventStats(eventId);

      // Broadcast: someone checked in
      emitToEvent(req, eventId, "attendee:checked_in", {
        eventId: parseInt(eventId),
        attendee: result.rows[0],
        stats,
      });

      res.json({
        success: true,
        message: `${result.rows[0].name} checked in successfully!`,
        data: result.rows[0],
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// ─── PATCH undo check-in ──────────────────────────────────────────────────────
router.patch(
  "/:attendeeId/undo-checkin",
  param("attendeeId").isInt(),
  async (req, res) => {
    const { eventId, attendeeId } = req.params;
    try {
      const result = await pool.query(
        `UPDATE attendees SET checked_in = FALSE, checked_in_at = NULL, updated_at = NOW()
       WHERE id = $1 AND event_id = $2 RETURNING *`,
        [attendeeId, eventId],
      );
      if (result.rows.length === 0)
        return res
          .status(404)
          .json({ success: false, message: "Attendee not found" });

      const stats = await getEventStats(eventId);

      // Broadcast: check-in undone
      emitToEvent(req, eventId, "attendee:unchecked", {
        eventId: parseInt(eventId),
        attendee: result.rows[0],
        stats,
      });

      res.json({
        success: true,
        message: "Check-in undone",
        data: result.rows[0],
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// ─── DELETE attendee ──────────────────────────────────────────────────────────
router.delete("/:attendeeId", param("attendeeId").isInt(), async (req, res) => {
  const { eventId, attendeeId } = req.params;
  try {
    const result = await pool.query(
      "DELETE FROM attendees WHERE id = $1 AND event_id = $2 RETURNING *",
      [attendeeId, eventId],
    );
    if (result.rows.length === 0)
      return res
        .status(404)
        .json({ success: false, message: "Attendee not found" });

    const stats = await getEventStats(eventId);

    emitToEvent(req, eventId, "attendee:deleted", {
      eventId: parseInt(eventId),
      attendeeId: parseInt(attendeeId),
      stats,
    });

    res.json({ success: true, message: "Attendee deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── DELETE all attendees ─────────────────────────────────────────────────────
router.delete("/", async (req, res) => {
  const { eventId } = req.params;
  try {
    await pool.query("DELETE FROM attendees WHERE event_id = $1", [eventId]);

    emitToEvent(req, eventId, "attendees:cleared", {
      eventId: parseInt(eventId),
      stats: { total_attendees: 0, checked_in_count: 0 },
    });

    res.json({ success: true, message: "All attendees cleared" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
