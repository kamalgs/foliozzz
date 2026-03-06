#!/bin/sh
# Inject OPENROUTER_API_KEY into the bundled app.js at container start
if [ -n "$OPENROUTER_API_KEY" ]; then
    sed -i "s|__OPENROUTER_API_KEY__|${OPENROUTER_API_KEY}|g" /usr/share/nginx/html/app.js
fi

exec "$@"
