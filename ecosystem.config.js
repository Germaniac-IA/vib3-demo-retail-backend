module.exports = {
  apps: [{
    name: 'baver-backend',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    env: {
      NODE_ENV: 'production',
      PORT: 4100,
      DATABASE_URL: 'postgresql://cristal:cristal123@localhost:5432/baver_retail',
      JWT_SECRET: 'baver-secret-change-in-production'
    }
  }]
};
