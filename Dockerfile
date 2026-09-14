FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CDPA_ONLINE=1 \
    CDPA_PORT=8765 \
    CDPA_DATA_DIR=/data

RUN groupadd --gid 10001 cdpa \
    && useradd --uid 10001 --gid cdpa --shell /usr/sbin/nologin --create-home cdpa

WORKDIR /app

COPY app ./app
COPY web ./web
COPY question_banks ./question_banks
COPY human_reference ./human_reference
COPY server.py ./

RUN mkdir -p /data /tmp/cdpa \
    && chown -R cdpa:cdpa /data /tmp/cdpa

USER cdpa
EXPOSE 8765

HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=5 \
  CMD python -c "import json,urllib.request; data=json.load(urllib.request.urlopen('http://127.0.0.1:8765/api/health',timeout=3)); raise SystemExit(0 if data.get('ok') else 1)"

CMD ["python", "server.py", "--online", "--host", "0.0.0.0", "--port", "8765", "--no-browser", "--data-dir", "/data"]
