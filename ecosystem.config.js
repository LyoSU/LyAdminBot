module.exports = {
  apps: [{
    name: 'LyAdminBot',
    script: './index.js',
    max_memory_restart: '1000M',
    // instances: 1,
    watch: true,
    ignore_watch: ['node_modules', 'assets'],
    env: {
      NODE_ENV: 'development'
    },
    env_production: {
      NODE_ENV: 'production'
    }
  }]
}
