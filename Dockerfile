FROM nginx:alpine

COPY index.html /usr/share/nginx/html/
COPY app.js /usr/share/nginx/html/
COPY duckdb-module.js /usr/share/nginx/html/
COPY styles.css /usr/share/nginx/html/
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh

# Copy data directory if it exists
COPY data/ /usr/share/nginx/html/data/

EXPOSE 80

ENTRYPOINT ["/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
