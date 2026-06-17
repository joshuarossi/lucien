#!/bin/bash

# Script to start Claude Code in a tmux session and run /loop for long-running tasks
# Usage: ./start-claude-loop.sh [--name SESSION_NAME] [--command "YOUR_PROMPT"]

set -e

# Configuration
TMUX_PREFIX="${TMUX_PREFIX:-claude-loop-$(date +%Y%m%d%H%M%S)}"
CLAUDE_CMD="claude"
TMUX_FLAGS="-n -c 'export CLAUDE_CODE_HOME=$HOME/.claude && exec $CLAUDE_CMD'"

# Parse arguments
COMMAND=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --name)
            TMUX_PREFIX="$2"
            shift 2
            ;;
        --command)
            COMMAND="$2"
            shift 2
            ;;
        --no-command)
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [--name SESSION_NAME] [--command 'PROMPT']"
            echo ""
            echo "Options:"
            echo "  --name     Session name (default: auto-generated)"
            echo "  --command  Prompt to send to Claude"
            echo "  --no-command  Don't send a command, just start the loop"
            echo ""
            echo "Example:"
            echo "  $0 --name my-project --command 'Analyze this codebase and generate a summary'"
            exit 0
            ;;
        *)
            shift
            ;;
    esac
done

# Kill existing session if it exists
if tmux has-session -t "$TMUX_PREFIX" 2>/dev/null; then
    echo "Killing existing session: $TMUX_PREFIX"
    tmux kill-session -t "$TMUX_PREFIX"
fi

# Start new session and launch Claude
echo "Starting tmux session: $TMUX_PREFIX"
tmux new-session -d -s "$TMUX_PREFIX" \
    "export CLAUDE_CODE_HOME=$HOME/.claude && exec $CLAUDE_CMD"

# Wait for Claude to start
echo "Waiting for Claude to initialize..."
sleep 3

# Send the /loop command
if [[ -n "$COMMAND" ]]; then
    echo "Sending command to Claude: $COMMAND"
    tmux send-keys -t "$TMUX_PREFIX" "/loop $COMMAND" Enter
else
    echo "Starting loop without specific command"
    tmux send-keys -t "$TMUX_PREFIX" "/loop" Enter
fi

echo "✅ Claude Code loop started in session: $TMUX_PREFIX"
echo "Session is running in the background."
echo ""
echo "To check status: tmux list-sessions"
echo "To view output: tmux attach -t $TMUX_PREFIX"
echo "To kill session: tmux kill-session -t $TMUX_PREFIX"
echo "To attach later: tmux attach -t $TMUX_PREFIX"
echo ""

# Store session info for easy access
echo "$TMUX_PREFIX" > ~/.claude-loop-session 2>/dev/null || true
