#!/bin/bash

# Kill any existing processes on port 1420
lsof -ti:1420 | xargs kill -9 2>/dev/null

# Start the demo server in the background
echo "Starting demo server..."
cd demo && npm run dev &
DEMO_PID=$!

# Wait for the server to start
sleep 3

# Run Tauri
echo "Starting Tauri..."
cd src-tauri && npx tauri dev

# Clean up when done
kill $DEMO_PID