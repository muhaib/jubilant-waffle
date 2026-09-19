// PM2 process definition. On the Hostinger VPS: pm2 start ecosystem.config.js --env production
module.exports = {
  apps: [
    {
      name: 'restaurant-pos',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      // Multiple instances would need a shared session/store for Socket.IO;
      // keep this at 1 unless you add a Redis adapter for socket.io.
      env_production: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '300M',
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      time: true,
    },
  ],
};
