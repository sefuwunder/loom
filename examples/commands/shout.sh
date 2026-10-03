#!/bin/sh
# /shout — example programmable shell slash command.
# Everything after the command arrives in $LOOM_ARGS.
echo "$LOOM_ARGS" | tr '[:lower:]' '[:upper:]'
