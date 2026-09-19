const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

let io = null;

function initRealtime(httpServer, corsOrigins) {
  io = new Server(httpServer, {
    cors: { origin: corsOrigins.length ? corsOrigins : true },
  });

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const user = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = user;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const { role, restaurant_id } = socket.user;
    if (role === 'super_admin') {
      socket.join('platform');
      if (restaurant_id) socket.join(`tenant:${restaurant_id}`);
    } else if (restaurant_id) {
      socket.join(`tenant:${restaurant_id}`);
    }
  });

  return io;
}

// Broadcast to every device logged into one restaurant (POS, KDS, table board)
// plus the platform room so the master admin dashboard can show live activity.
function emitToTenant(restaurantId, event, payload) {
  if (!io) return;
  io.to(`tenant:${restaurantId}`).emit(event, payload);
  io.to('platform').emit(event, { restaurant_id: restaurantId, ...payload });
}

function emitToPlatform(event, payload) {
  if (!io) return;
  io.to('platform').emit(event, payload);
}

module.exports = { initRealtime, emitToTenant, emitToPlatform };
