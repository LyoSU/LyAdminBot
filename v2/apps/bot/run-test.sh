#!/bin/zsh
# Test-bot runner: @LyTestBot against the local isolated Mongo.
# Fully detached (setsid + nohup) so it survives any parent shell.
# Usage: ./run-test.sh [stop|status|log]

set -euo pipefail
cd "$(dirname "$0")"

PIDFILE=/tmp/lytest-bot.pid
LOGFILE=/tmp/lytest-bot.log
ENVFILE=../../../.env

case "${1:-start}" in
  stop)
    [[ -f $PIDFILE ]] && kill "$(cat $PIDFILE)" 2>/dev/null && echo "stopped" || echo "not running"
    rm -f $PIDFILE
    exit 0 ;;
  status)
    if [[ -f $PIDFILE ]] && kill -0 "$(cat $PIDFILE)" 2>/dev/null; then
      echo "running (pid $(cat $PIDFILE))"
    else
      echo "not running"
    fi
    exit 0 ;;
  log)
    tail -n 40 $LOGFILE
    exit 0 ;;
esac

# Already running? Don't double-start.
if [[ -f $PIDFILE ]] && kill -0 "$(cat $PIDFILE)" 2>/dev/null; then
  echo "already running (pid $(cat $PIDFILE))"
  exit 0
fi

# Kill stray copies not tracked by the pidfile — two pollers on one bot
# token answer updates randomly, and an old process serves old code.
for pid in $(pgrep -f 'tsx src/main.ts' 2>/dev/null); do
  echo "killing stray bot copy (pid $pid)"
  kill "$pid" 2>/dev/null || true
done

# Pull required vars from the repo .env (strip quotes), force test DB.
export $(grep -v '^#' $ENVFILE | grep -E '^(BOT_TOKEN|API_ID|API_HASH|OPENAI_API_KEY|OPENROUTER_API_KEY)=' | sed 's/"//g' | xargs)
export MONGODB_URI="mongodb://localhost:27017/LyAdminBotV2Test"
export SESSION_PATH="$PWD/.mtcute-session/lytest"

nohup ../../node_modules/.bin/tsx src/main.ts >> $LOGFILE 2>&1 &
echo $! > $PIDFILE
disown
sleep 1
echo "started (pid $(cat $PIDFILE)), log: $LOGFILE"
