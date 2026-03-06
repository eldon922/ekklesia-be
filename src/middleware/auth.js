const jwt = require("jsonwebtoken");
const pool = require("../db");

const JWT_SECRET = process.env.JWT_SECRET || "ekklesia-secret-change-in-production";
const TOKEN_TTL = "8h";

/**
 * requireEventAccess
 *
 * All routes (read and write) require a valid JWT to protect attendee privacy.
 * Unprotected events still get a token automatically on page load.
 * Token contains: { eventId }
 */
async function requireEventAccess(req, res, next) {
  const eventId = req.params.eventId || req.params.id;

  try {
    const result = await pool.query(
      "SELECT id FROM events WHERE id = $1",
      [eventId],
    );

    if (result.rows.length === 0)
      return res.status(404).json({ success: false, message: "Event not found" });

    const authHeader = req.headers["authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
        code: "AUTH_REQUIRED",
      });
    }

    const token = authHeader.slice(7);
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      const code = err.name === "TokenExpiredError" ? "AUTH_EXPIRED" : "AUTH_INVALID";
      return res.status(401).json({
        success: false,
        message: "Invalid or expired session. Please re-authenticate.",
        code,
      });
    }

    if (String(payload.eventId) !== String(eventId)) {
      return res.status(403).json({
        success: false,
        message: "Token does not match this event.",
        code: "AUTH_MISMATCH",
      });
    }

    next();
  } catch (err) {
    console.error("Auth middleware error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
}

module.exports = { requireEventAccess, JWT_SECRET, TOKEN_TTL };
