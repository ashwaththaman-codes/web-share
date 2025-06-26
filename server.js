const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// Serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint for Render
app.get('/health', (req, res) => {
  console.log('Health check requested');
  res.status(200).send('OK');
});

// Track hosts, pending signals, and clients with cursor access
const rooms = new Map();
const pendingSignals = new Map();
const connectedClients = new Map();
const clientsWithCursorAccess = new Map(); // Track clients with cursor access per room

io.on('connection', socket => {
  console.log('User connected:', socket.id);

  socket.on('join', ({ room, isHost }) => {
    if (connectedClients.get(socket.id) === room) {
      console.log(`Duplicate join attempt by ${socket.id} for room ${room}`);
      return;
    }

    console.log(`Join request: room=${room}, isHost=${isHost}, socket=${socket.id}`);
    if (isHost) {
      if (rooms.has(room)) {
        console.log(`Host rejected: room ${room} already has a host`);
        socket.emit('error', 'Room already has a host');
        return;
      }
      rooms.set(room, socket.id);
      console.log(`Host added: room=${room}, host=${socket.id}`);
    } else if (!rooms.has(room)) {
      console.log(`No host in room: ${room}`);
      socket.emit('no-host', 'No host found in room: ' + room);
      return;
    }

    socket.join(room);
    connectedClients.set(socket.id, room);
    console.log(`User ${socket.id} joined room: ${room}`);
    socket.to(room).emit('user-joined', socket.id);

    if (!isHost && pendingSignals.has(room)) {
      pendingSignals.get(room).forEach(signal => {
        console.log(`Sending pending signal to client ${socket.id}:`, JSON.stringify(signal, null, 2));
        socket.emit('signal', signal);
      });
      pendingSignals.delete(room);
    }
  });

  socket.on('signal', ({ room, data }) => {
    console.log(`Signal from ${socket.id} to room ${room}:`, JSON.stringify(data, null, 2));
    const targetSocket = io.sockets.adapter.rooms.get(room);
    if (targetSocket && targetSocket.size > 1) {
      console.log(`Emitting signal to room ${room} from ${socket.id}`);
      socket.to(room).emit('signal', { id: socket.id, data });
    } else {
      console.log(`No other users in room ${room}, buffering signal from ${socket.id}`);
      if (!pendingSignals.has(room)) {
        pendingSignals.set(room, []);
      }
      pendingSignals.get(room).push({ id: socket.id, data });
    }
  });

  socket.on('cursor-request', ({ room }) => {
    console.log(`Cursor request from ${socket.id} for room ${room}`);
    const hostId = rooms.get(room);
    if (hostId) {
      io.to(hostId).emit('cursor-request', { clientId: socket.id });
    } else {
      socket.emit('no-host', 'No host found in room: ' + room);
    }
  });

  socket.on('cursor-response', ({ room, clientId, approved }) => {
    console.log(`Cursor response from host for client ${clientId} in room ${room}: ${approved}`);
    if (approved) {
      if (!clientsWithCursorAccess.has(room)) {
        clientsWithCursorAccess.set(room, new Set());
      }
      clientsWithCursorAccess.get(room).add(clientId);
    }
    io.to(clientId).emit('cursor-response', { approved });
  });

  socket.on('mouseMove', ({ room, x, y }) => {
    const clientRoom = connectedClients.get(socket.id);
    if (clientRoom === room && clientsWithCursorAccess.get(room)?.has(socket.id)) {
      socket.to(room).emit('mouseMove', { x, y });
    } else {
      console.log(`Unauthorized mouseMove from ${socket.id} in room ${room}`);
    }
  });

  socket.on('mouseClick', ({ room, button }) => {
    const clientRoom = connectedClients.get(socket.id);
    if (clientRoom === room && clientsWithCursorAccess.get(room)?.has(socket.id)) {
      socket.to(room).emit('mouseClick', { button });
    } else {
      console.log(`Unauthorized mouseClick from ${socket.id} in room ${room}`);
    }
  });

  socket.on('leave', ({ room }) => {
    console.log(`Leave request: room=${room}, socket=${socket.id}`);
    socket.leave(room);
    connectedClients.delete(socket.id);
    if (rooms.get(room) === socket.id) {
      rooms.delete(room);
      pendingSignals.delete(room);
      clientsWithCursorAccess.delete(room);
      socket.to(room).emit('user-disconnected', socket.id);
      console.log(`Host removed: room=${room}`);
    } else if (clientsWithCursorAccess.get(room)?.has(socket.id)) {
      clientsWithCursorAccess.get(room).delete(socket.id);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    const room = connectedClients.get(socket.id);
    if (room) {
      connectedClients.delete(socket.id);
      if (rooms.get(room) === socket.id) {
        rooms.delete(room);
        pendingSignals.delete(room);
        clientsWithCursorAccess.delete(room);
        socket.to(room).emit('user-disconnected', socket.id);
        console.log(`Host disconnected: room=${room}`);
      } else if (clientsWithCursorAccess.get(room)?.has(socket.id)) {
        clientsWithCursorAccess.get(room).delete(socket.id);
      }
    }
  });

  socket.on('error', err => {
    console.error('Socket error:', err);
  });
});

const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
});

server.on('listening', () => {
  console.log(`Server confirmed listening on port ${port}`);
});
