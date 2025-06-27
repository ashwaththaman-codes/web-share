const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const robot = require('robotjs');

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

function startScreenCapture(room, socket) {
  const screenSize = robot.getScreenSize();
  const width = 1280; // Resize for performance
  const height = Math.round((screenSize.height / screenSize.width) * width);

  function capture() {
    try {
      const img = robot.screen.capture(0, 0, screenSize.width, screenSize.height);
      const dataUrl = `data:image/jpeg;base64,${Buffer.from(img.image).toString('base64')}`;
      console.log(`Sending screen update for room ${room}, image size: ${dataUrl.length} bytes`);
      socket.to(room).emit('screen-update', { image: dataUrl });
      socket.emit('screen-update', { image: dataUrl }); // Host also sees the screen
    } catch (err) {
      console.error('Screen capture error:', err.message);
    }
  }

  const interval = setInterval(capture, 2000); // Capture every 2 seconds
  return () => clearInterval(interval);
}

io.on('connection', socket => {
  console.log('User connected:', socket.id);
  let captureInterval = null;

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
    captureInterval = startScreenCapture(room, socket);
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
      captureInterval = startScreenCapture(room, socket);
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
      console.log(`Processing mouseMove from ${socket.id} in room ${room}: x=${x}, y=${y}`);
      try {
        const screenSize = robot.getScreenSize();
        const targetX = Math.round(x * screenSize.width);
        const targetY = Math.round(y * screenSize.height);
        console.log(`Moving mouse to screen coordinates: x=${targetX}, y=${targetY}`);
        robot.moveMouse(targetX, targetY);
        socket.to(room).emit('mouseMove', { clientId: socket.id, x, y });
        io.to(rooms.get(room)).emit('mouseMove', { clientId: socket.id, x, y }); // Ensure host sees cursor
      } catch (err) {
        console.error(`Mouse move error for ${socket.id}: ${err.message}`);
      }
    } else {
      console.log(`Unauthorized mouseMove from ${socket.id} in room ${room}`);
    }
  });

  socket.on('mouseClick', ({ room, button }) => {
    const clientRoom = connectedClients.get(socket.id);
    if (clientRoom === room && clientsWithCursorAccess.get(room)?.has(socket.id)) {
      console.log(`Processing mouseClick from ${socket.id} in room ${room}: button=${button}`);
      try {
        robot.mouseClick(button);
        socket.to(room).emit('mouseClick', { clientId: socket.id, button });
        io.to(rooms.get(room)).emit('mouseClick', { clientId: socket.id, button }); // Ensure host sees click
      } catch (err) {
        console.error(`Mouse click error for ${socket.id}: ${err.message}`);
      }
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
      clientsWithCursorAccess.delete(room);
      socket.to(room).emit('host-stopped');
      console.log(`Host removed: room=${room}`);
      if (captureInterval) captureInterval();
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
        if (captureInterval) captureInterval();
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
