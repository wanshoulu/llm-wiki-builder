FROM python:3.11-slim

WORKDIR /app

# 安装依赖
COPY python/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# 复制应用代码
COPY python/app /app/app

# 创建 workspace 目录
RUN mkdir -p /app/workspace

EXPOSE 8100

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100", "--log-level", "info"]
