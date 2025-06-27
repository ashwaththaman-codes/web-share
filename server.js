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

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  console.log('Health check requested');
  res.status(200).send('OK');
});

const rooms = new Map();
const connectedClients = new Map();
const clientsWithCursorAccess = new Map();

io.on('connection', socket => {
  console.log('User connected:', socket.id);

  socket.on('start-host', ({ room }) => {
    if (rooms.has(room)) {
      console.log(`Host rejected: room ${room} already has a host`);
      socket.emit('error', 'Room already has a host');
      return;
    }
    rooms.set(room, socket.id);
    connectedClients.set(socket.id, room);
    socket.join(room);
    console.log(`Host started: room=${room}, host=${socket.id}`);
  });

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
      console.log(`Client ${clientId} granted cursor access in room ${room}`);
    }
    io.to(clientId).emit('cursor-response', { approved });
  });

  socket.on('mouseMove', ({ room, x, y }) => {
    const clientRoom = connectedClients.get(socket.id);
    if (clientRoom === room && clientsWithCursorAccess.get(room)?.has(socket.id)) {
      console.log(`Relaying mouseMove from ${socket.id} in room ${room}: x=${x}, y=${y}`);
      socket.to(room).emit('mouseMove', { clientId: socket.id, x, y });
      io.to(rooms.get(room)).emit('mouseMove', { clientId: socket.id, x, y });
    } else {
      console.log(`Unauthorized mouseMove from ${socket.id} in room ${room}`);
    }
  });

  socket.on('mouseClick', ({ room, button }) => {
    const clientRoom = connectedClients.get(socket.id);
    if (clientRoom === room && clientsWithCursorAccess.get(room)?.has(socket.id)) {
      console.log(`Relaying mouseClick from ${socket.id} in room ${room}: button=${button}`);
      socket.to(room).emit('mouseClick', { clientId: socket.id, button });
      io.to(rooms.get(room)).emit('mouseClick', { clientId: socket.id, button });
    } else {
      console.log(`Unauthorized mouseClick from ${socket.id} in room ${room}`);
    }
  });

  socket.on('offer', ({ room, offer }) => {
    console.log(`Relaying offer from ${socket.id} in room ${room}`);
    socket.to(room).emit('offer', { offer });
  });

  socket.on('answer', ({ room, answer }) => {
    console.log(`Relaying answer from ${socket.id} in room ${room}`);
    socket.to(room).emit('answer', { answer });
  });

  socket.on('ice-candidate', ({ room, candidate }) => {
    console.log(`Relaying ICE candidate from ${socket.id} in room ${room}`);
    socket.to(room).emit('ice-candidate', { candidate });
  });

  socket.on('leave', ({ room }) => {
    console.log(`Leave request: room=${room}, socket=${socket.id}`);
    socket.leave(room);
    connectedClients.delete(socket.id);
    if (rooms.get(room) === socket.id) {
      rooms.delete(room);
      clientsWithCursorAccess.delete(room);
      socket.to(room).emit('host-stopped');
      console.log(`Host removed: room=${room}`);
    } else if (clientsWithCursorAccess.get(room)?.has(socket.id)) {
      clientsWithCursorAccess.get(room).delete(socket.id);
      socket.to(room).emit('user-disconnected', socket.id);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    const room = connectedClients.get(socket.id);
    if (room) {
      connectedClients.delete(socket.id);
      if (rooms.get(room) === socket.id) {
        rooms.delete(room);
        clientsWithCursorAccess.delete(room);
        socket.to(room).emit('host-stopped');
        console.log(`Host disconnected: room=${room}`);
      } else if (clientsWithCursorAccess.get(room)?.has(socket.id)) {
        clientsWithCursorAccess.get(room).delete(socket.id);
        socket.to(room).emit('user-disconnected', socket.id);
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
