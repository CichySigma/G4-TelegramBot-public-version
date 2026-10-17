#!/bin/sh
set -eu
Xvfb :99 -screen 0 1366x768x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
xvfb_pid=$!
export DISPLAY=:99
attempt=0
until [ -S /tmp/.X11-unix/X99 ]; do
  attempt=$((attempt+1))
  if [ "$attempt" -gt 50 ]; then cat /tmp/xvfb.log; exit 1; fi
  sleep 0.1
done
x11vnc -display :99 -localhost -nopw -forever -shared -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
vnc_pid=$!
websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 >/tmp/novnc.log 2>&1 &
web_pid=$!
node src/index.js &
bot_pid=$!
cleanup() {
  trap - TERM INT
  kill -TERM "$bot_pid" 2>/dev/null || true
  wait "$bot_pid" 2>/dev/null || true
  kill "$web_pid" "$vnc_pid" "$xvfb_pid" 2>/dev/null || true
}
trap cleanup TERM INT
set +e
wait "$bot_pid"
result=$?
cleanup
exit "$result"
