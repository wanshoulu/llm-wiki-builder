FROM python:3.11-slim

WORKDIR /app

# 安装依赖
COPY python/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# 复制应用代码
COPY python/app /app/app

# 复制 workspace（skills：document-review-wiki-builder 等）
COPY workspace /app/workspace

# wiki 存储目录（compose 挂载宿主机 d:/project/vscode/wiki，与 ontomind-agent 共享）
RUN mkdir -p /app/storage/wiki

EXPOSE 8500

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8500", "--log-level", "info"]
