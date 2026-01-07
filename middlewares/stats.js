const { stats: statsLog } = require('../helpers/logger')

const stats = {
  rpsAvrg: 0,
  responseTimeAvrg: 0,
  times: {}
}

setInterval(() => {
  if (Object.keys(stats.times).length > 0) {
    Object.keys(stats.times).forEach(time => {
      const rps = stats.times[time].length
      stats.rpsAvrg = (stats.rpsAvrg + rps) / 2

      const sumResponseTime = stats.times[time].reduce((a, b) => a + b, 0)
      const lastResponseTimeAvrg = (sumResponseTime / stats.times[time].length) || 0
      stats.responseTimeAvrg = (stats.responseTimeAvrg + lastResponseTimeAvrg) / 2

      // Only log when there's actual traffic (rps > 0)
      if (rps > 0) {
        statsLog.trace({
          rpsLast: rps,
          rpsAvrg: stats.rpsAvrg.toFixed(2),
          responseTimeLast: lastResponseTimeAvrg.toFixed(2),
          responseTimeAvrg: stats.responseTimeAvrg.toFixed(2)
        }, 'Performance metrics')
      }
      delete stats.times[time]
    })
  }
}, 1000)

module.exports = (ctx, next) => {
  ctx.state.startMs = new Date()

  return next().then(async () => {
    const now = Math.floor(new Date() / 1000)
    if (!stats.times[now]) stats.times[now] = []
    stats.times[now].push(new Date() - ctx.state.startMs)
  })
}
