require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const initDatabase = require('./migrate');
const eventsRouter = require('./routes/events');
const attendeesRouter = require('./routes/attendees');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 4000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// ─── Socket.io setup ────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: FRONTEND_URL,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    credentials: true,
  },
});

io.on('connection', (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);

  // Each client joins a room per event they are watching
  socket.on('join_event', (eventId) => {
    socket.join(`event:${eventId}`);
    console.log(`[WS] ${socket.id} joined event:${eventId}`);
  });

  socket.on('leave_event', (eventId) => {
    socket.leave(`event:${eventId}`);
  });

  socket.on('disconnect', () => {
    console.log(`[WS] Client disconnected: ${socket.id}`);
  });
});

// Make io accessible in route handlers via req.app.get('io')
app.set('io', io);

// ─── Express middleware ──────────────────────────────────────────────────────
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Routes ─────────────────────────────────────────────────────────────────
app.use('/api/events', eventsRouter);
app.use('/api/events/:eventId/attendees', attendeesRouter);

// Health check
app.get('/api/health', (req, res) => {
  const connectedClients = io.engine.clientsCount;
  res.json({
    success: true,
    message: 'Ekklesia API is running',
    timestamp: new Date().toISOString(),
    connected_clients: connectedClients,
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// ─── Start ───────────────────────────────────────────────────────────────────
const start = async () => {
  try {
    await initDatabase();
    server.listen(PORT, () => {
      console.log(`🏛️  Ekklesia server running on http://localhost:${PORT}`);
      console.log(`🔌 Socket.io ready`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
};

start();
