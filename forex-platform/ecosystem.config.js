// PM2 process definition. `pm2 start ecosystem.config.js --env production`
module.exports = {
  apps: [{
    name: 'fxp',
    script: 'server.js',
    instances: 1,            // see the note on rate limiting in README.md
    exec_mode: 'fork',
    max_memory_restart: '400M',
    env_production: { NODE_ENV: 'production' },
    error_file: '/var/log/fxp/error.log',
    out_file: '/var/log/fxp/out.log',
    time: true,
  }],
};
