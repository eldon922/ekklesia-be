const express = require("express");
const router = express.Router({ mergeParams: true });
const pool = require("../db");
const multer = require("multer");
const XLSX = require("xlsx");
const { body, param, validationResult } = require("express-validator");
const { requireEventAccess } = require("../middleware/auth");

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
  let digits = number.toString().replace(/\D/g, "");
  return digits;
}

function normalizeName(name) {
  if (!name) return "";
  return name
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Helper: emit to all clients watching this event
function emitToEvent(req, eventId, event, payload) {
  const io = req.app.get("io");
  if (io) io.to(`event:${eventId}`).emit(event, payload);
}

// ─── GET attendees with optional search/filter ───────────────────────────────
router.get("/", requireEventAccess, async (req, res) => {
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
    res.status(500).json({ success: false, code: "SERVER_ERROR", message: "Server error" });
  }
});

// ─── i18n labels for Excel export ────────────────────────────────────────────
const EXPORT_LABELS = {
  id: {
    col_no: "No",
    col_name: "Nama",
    col_phone: "No. Telepon",
    col_church: "Gereja Asal",
    col_status: "Status",
    col_checkin_time: "Waktu Check-in",
    col_source: "Sumber Data",
    status_checked: "Sudah Check-in",
    status_pending: "Belum Check-in",
    source_import: "Import File",
    source_manual: "Manual",
    info_event: "Acara",
    info_date: "Tanggal Acara",
    info_location: "Lokasi",
    info_total: "Total Peserta",
    info_checked: "Sudah Check-in",
    info_exported: "Diekspor pada",
    sheet_attendees: "Peserta",
    sheet_info: "Info Export",
  },
  en: {
    col_no: "No",
    col_name: "Name",
    col_phone: "Phone Number",
    col_church: "Home Church",
    col_status: "Status",
    col_checkin_time: "Check-in Time",
    col_source: "Source",
    status_checked: "Checked In",
    status_pending: "Pending",
    source_import: "Imported",
    source_manual: "Manual",
    info_event: "Event",
    info_date: "Event Date",
    info_location: "Location",
    info_total: "Total Attendees",
    info_checked: "Checked In",
    info_exported: "Exported at",
    sheet_attendees: "Attendees",
    sheet_info: "Export Info",
  },
};

// ─── GET export attendees as Excel ───────────────────────────────────────────
router.get("/export", requireEventAccess, async (req, res) => {
  const { eventId } = req.params;
  const lang = req.query.lang === "en" ? "en" : "id";
  const L = EXPORT_LABELS[lang];

  try {
    const eventRes = await pool.query("SELECT * FROM events WHERE id = $1", [
      eventId,
    ]);
    if (eventRes.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, code: "EVENT_NOT_FOUND", message: "Event not found" });
    }
    const event = eventRes.rows[0];

    const attendeesRes = await pool.query(
      "SELECT * FROM attendees WHERE event_id = $1 ORDER BY id ASC",
      [eventId],
    );

    const exportedAt = new Date();

    const rows = attendeesRes.rows.map((a, i) => ({
      [L.col_no]: i + 1,
      [L.col_name]: a.name,
      [L.col_phone]: a.phone_number || "",
      [L.col_church]: a.email || "",
      [L.col_status]: a.checked_in ? L.status_checked : L.status_pending,
      [L.col_checkin_time]: a.checked_in_at
        ? new Date(a.checked_in_at).toISOString()
        : "",
      [L.col_source]: a.source === "import" ? L.source_import : L.source_manual,
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);

    ws["!cols"] = [
      { wch: 5 },
      { wch: 30 },
      { wch: 18 },
      { wch: 30 },
      { wch: 18 },
      { wch: 22 },
      { wch: 14 },
    ];

    XLSX.utils.book_append_sheet(wb, ws, L.sheet_attendees);

    const infoData = [
      [L.info_event, event.name],
      [L.info_date, event.date || "-"],
      [L.info_location, event.location || "-"],
      [L.info_total, attendeesRes.rows.length],
      [L.info_checked, attendeesRes.rows.filter((a) => a.checked_in).length],
      [L.info_exported, exportedAt.toISOString()],
    ];
    const infoWs = XLSX.utils.aoa_to_sheet(infoData);
    infoWs["!cols"] = [{ wch: 20 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, infoWs, L.sheet_info);

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ success: false, code: "EXPORT_FAILED", message: "Export failed: " + err.message });
  }
});

// ─── POST create single attendee ─────────────────────────────────────────────
router.post(
  "/",
  requireEventAccess,
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
      // Block if event is finished
      const eventCheck = await pool.query(
        "SELECT is_finished FROM events WHERE id = $1",
        [eventId],
      );
      if (eventCheck.rows[0]?.is_finished) {
        return res.status(403).json({
          success: false,
          message:
            "This event has been finished. Adding attendees is disabled.", code: "EVENT_FINISHED",
        });
      }

      const result = await pool.query(
        `INSERT INTO attendees (event_id, name, phone_number, email, source) VALUES ($1, $2, $3, $4, 'manual') RETURNING *`,
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
      res.status(500).json({ success: false, code: "SERVER_ERROR", message: "Server error" });
    }
  },
);

// ─── POST import from CSV/Excel ───────────────────────────────────────────────
router.post("/import", requireEventAccess, upload.single("file"), async (req, res) => {
  const { eventId } = req.params;

  if (!req.file) {
    return res
      .status(400)
      .json({ success: false, code: "NO_FILE", message: "No file uploaded" });
  }

  try {
    // Block if event is finished
    const eventCheck = await pool.query(
      "SELECT is_finished FROM events WHERE id = $1",
      [eventId],
    );
    if (eventCheck.rows[0]?.is_finished) {
      return res.status(403).json({
        success: false,
        message:
          "This event has been finished. Importing attendees is disabled.", code: "EVENT_FINISHED",
      });
    }

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    if (rows.length === 0) {
      return res
        .status(400)
        .json({ success: false, code: "FILE_EMPTY", message: "File is empty or has no data" });
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
    // email column also recognises "Gereja Asal" variants
    const emailKeys = [
      "email",
      "email address",
      "emailaddress",
      "e-mail",
      "gereja asal",
      "gereja",
      "asal gereja",
      "home church",
      "church",
    ];

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
        code: "MISSING_NAME_COLUMN",
        message: "MISSING_NAME_COLUMN",
        detected_columns: Object.keys(firstRow),
      });
    }

    const client = await pool.connect();
    let imported = 0;
    let blankRows = 0;
    const duplicates = [];

    try {
      await client.query("BEGIN");

      // Check if this is a first-time import (no existing attendees)
      const countRes = await client.query(
        "SELECT COUNT(id) AS cnt FROM attendees WHERE event_id = $1",
        [eventId],
      );
      const isFirstImport = parseInt(countRes.rows[0].cnt) === 0;

      for (const row of rows) {
        const name = row[nameKey]?.toString().trim();
        const phone = phoneKey ? row[phoneKey]?.toString().trim() : null;
        const email = emailKey ? row[emailKey]?.toString().trim() : null;

        if (!name) {
          blankRows++;
          continue;
        }

        // Only check for duplicates on subsequent imports (not the first one)
        if (!isFirstImport) {
          let duplicateMatch = null;

          const normPhone = normalizePhone(phone);
          if (normPhone) {
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
              rowIndex: rows.indexOf(row) + 2,
              matchedBy: duplicateMatch.matchedBy,
              existingName: duplicateMatch.existingName,
              existingPhone: duplicateMatch.existingPhone,
            });
            continue;
          }
        }

        await client.query(
          `INSERT INTO attendees (event_id, name, phone_number, email, source) VALUES ($1, $2, $3, $4, 'import')`,
          [eventId, name, phone || null, email || null],
        );
        imported++;
      }

      await client.query("COMMIT");

      const stats = await getEventStats(eventId);

      emitToEvent(req, eventId, "attendees:imported", {
        eventId: parseInt(eventId),
        imported,
        blankRows,
        stats,
      });

      res.json({
        success: true,
        code: duplicates.length > 0 ? "IMPORT_PARTIAL" : "IMPORT_COMPLETE",
        message: duplicates.length > 0 ? "IMPORT_PARTIAL" : "IMPORT_COMPLETE",
        imported,
        blankRows,
        duplicateCount: duplicates.length,
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
    res.status(500).json({
      success: false,
      code: "IMPORT_FAILED", message: "Error processing file: " + err.message,
    });
  }
});

// ─── POST import approved duplicates ──────────────────────────────────────────
router.post("/import-duplicates", requireEventAccess, async (req, res) => {
  const { eventId } = req.params;
  const { duplicates } = req.body;

  if (!duplicates || !Array.isArray(duplicates)) {
    return res.status(400).json({
      success: false,
      code: "NO_DUPLICATES",
      message: "NO_DUPLICATES",
    });
  }

  try {
    // Block if event is finished
    const eventCheck = await pool.query(
      "SELECT is_finished FROM events WHERE id = $1",
      [eventId],
    );
    if (eventCheck.rows[0]?.is_finished) {
      return res.status(403).json({
        success: false,
        message:
          "This event has been finished. Importing attendees is disabled.", code: "EVENT_FINISHED",
      });
    }

    const client = await pool.connect();
    let imported = 0;

    try {
      await client.query("BEGIN");

      for (const dup of duplicates) {
        const { name, phone, email } = dup;
        if (!name) continue;

        await client.query(
          `INSERT INTO attendees (event_id, name, phone_number, email, source) VALUES ($1, $2, $3, $4, 'import')`,
          [eventId, name, phone || null, email || null],
        );
        imported++;
      }

      await client.query("COMMIT");

      const stats = await getEventStats(eventId);

      emitToEvent(req, eventId, "attendees:imported", {
        eventId: parseInt(eventId),
        imported,
        skipped: 0,
        stats,
      });

      res.json({
        success: true,
        code: "IMPORT_DUPLICATES_COMPLETE", message: "IMPORT_DUPLICATES_COMPLETE",
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
      code: "IMPORT_FAILED", message: "Error importing duplicates: " + err.message,
    });
  }
});

// ─── PATCH update attendee ────────────────────────────────────────────────────
router.patch(
  "/:attendeeId",
  requireEventAccess,
  param("attendeeId").isInt(),
  body("name").notEmpty().trim(),
  body("phone_number").optional({ checkFalsy: true }).trim(),
  body("email").optional({ checkFalsy: true }).trim(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ success: false, errors: errors.array() });

    const { eventId, attendeeId } = req.params;
    const { name, phone_number, email } = req.body;

    try {
      // Block if event is finished
      const eventCheck = await pool.query(
        "SELECT is_finished FROM events WHERE id = $1",
        [eventId],
      );
      if (eventCheck.rows[0]?.is_finished) {
        return res.status(403).json({
          success: false,
          message: "This event has been finished. Editing attendees is disabled.", code: "EVENT_FINISHED",
        });
      }

      const result = await pool.query(
        `UPDATE attendees
         SET name = $1, phone_number = $2, email = $3, updated_at = NOW()
         WHERE id = $4 AND event_id = $5
         RETURNING *`,
        [name, phone_number || null, email || null, attendeeId, eventId],
      );

      if (result.rows.length === 0)
        return res.status(404).json({ success: false, code: "ATTENDEE_NOT_FOUND", message: "Attendee not found" });

      emitToEvent(req, eventId, "attendee:updated", {
        eventId: parseInt(eventId),
        attendee: result.rows[0],
      });

      res.json({ success: true, data: result.rows[0] });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, code: "SERVER_ERROR", message: "Server error" });
    }
  },
);

// ─── PATCH check-in ───────────────────────────────────────────────────────────
router.patch(
  "/:attendeeId/checkin",
  requireEventAccess,
  param("attendeeId").isInt(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ success: false, errors: errors.array() });

    const { eventId, attendeeId } = req.params;
    try {
      // Block check-in if event is finished
      const eventCheck = await pool.query(
        "SELECT is_finished FROM events WHERE id = $1",
        [eventId],
      );
      if (eventCheck.rows.length === 0) {
        return res
          .status(404)
          .json({ success: false, code: "EVENT_NOT_FOUND", message: "Event not found" });
      }
      if (eventCheck.rows[0].is_finished) {
        return res.status(403).json({
          success: false,
          message:
            "This event has been finished. Check-in is disabled.", code: "EVENT_FINISHED",
        });
      }

      const current = await pool.query(
        "SELECT * FROM attendees WHERE id = $1 AND event_id = $2",
        [attendeeId, eventId],
      );

      if (current.rows.length === 0) {
        return res
          .status(404)
          .json({ success: false, code: "ATTENDEE_NOT_FOUND", message: "Attendee not found" });
      }

      const attendee = current.rows[0];

      if (attendee.checked_in) {
        // Return the attendee data so the client can format the time in its own timezone
        return res.status(409).json({
          success: false,
          message: `${attendee.name} is already checked in`, code: "ALREADY_CHECKED_IN",
          data: attendee,
        });
      }

      const result = await pool.query(
        `UPDATE attendees SET checked_in = TRUE, checked_in_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND event_id = $2 RETURNING *`,
        [attendeeId, eventId],
      );

      const stats = await getEventStats(eventId);

      emitToEvent(req, eventId, "attendee:checked_in", {
        eventId: parseInt(eventId),
        attendee: result.rows[0],
        stats,
      });

      res.json({
        success: true,
        code: "CHECKIN_SUCCESS", attendeeName: result.rows[0].name, message: "CHECKIN_SUCCESS",
        data: result.rows[0],
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, code: "SERVER_ERROR", message: "Server error" });
    }
  },
);

// ─── PATCH undo check-in ──────────────────────────────────────────────────────
router.patch(
  "/:attendeeId/undo-checkin",
  requireEventAccess,
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
          .json({ success: false, code: "ATTENDEE_NOT_FOUND", message: "Attendee not found" });

      const stats = await getEventStats(eventId);

      emitToEvent(req, eventId, "attendee:unchecked", {
        eventId: parseInt(eventId),
        attendee: result.rows[0],
        stats,
      });

      res.json({
        success: true,
        code: "UNDO_SUCCESS", message: "Check-in undone",
        data: result.rows[0],
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, code: "SERVER_ERROR", message: "Server error" });
    }
  },
);

// ─── DELETE attendee ──────────────────────────────────────────────────────────
router.delete("/:attendeeId", requireEventAccess, param("attendeeId").isInt(), async (req, res) => {
  const { eventId, attendeeId } = req.params;
  try {
    // Block if event is finished
    const eventCheck = await pool.query(
      "SELECT is_finished FROM events WHERE id = $1",
      [eventId],
    );
    if (eventCheck.rows[0]?.is_finished) {
      return res.status(403).json({
        success: false,
        message:
          "This event has been finished. Deleting attendees is disabled.", code: "EVENT_FINISHED",
      });
    }

    const result = await pool.query(
      "DELETE FROM attendees WHERE id = $1 AND event_id = $2 RETURNING *",
      [attendeeId, eventId],
    );
    if (result.rows.length === 0)
      return res
        .status(404)
        .json({ success: false, code: "ATTENDEE_NOT_FOUND", message: "Attendee not found" });

    const stats = await getEventStats(eventId);

    emitToEvent(req, eventId, "attendee:deleted", {
      eventId: parseInt(eventId),
      attendeeId: parseInt(attendeeId),
      stats,
    });

    res.json({ success: true, code: "ATTENDEE_DELETED", message: "Attendee deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, code: "SERVER_ERROR", message: "Server error" });
  }
});

// ─── DELETE all attendees ─────────────────────────────────────────────────────
router.delete("/", requireEventAccess, async (req, res) => {
  const { eventId } = req.params;
  try {
    await pool.query("DELETE FROM attendees WHERE event_id = $1", [eventId]);

    emitToEvent(req, eventId, "attendees:cleared", {
      eventId: parseInt(eventId),
      stats: { total_attendees: 0, checked_in_count: 0 },
    });

    res.json({ success: true, code: "ATTENDEES_CLEARED", message: "All attendees cleared" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, code: "SERVER_ERROR", message: "Server error" });
  }
});

module.exports = router;
