FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1


COPY pyproject.toml README.md ./
COPY src ./src
COPY skills ./skills
COPY tests ./tests

RUN python -m pip install --no-cache-dir ".[dev]"

CMD ["pytest"]
