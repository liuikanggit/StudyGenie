FROM python:3.9-slim

WORKDIR /app

# 优先安装依赖加速构建
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制所有文件（自动包含 main.py, questions.json 和 static 静态目录）
COPY . .

# 暴露 FastAPI 的默认端口
EXPOSE 8000

# 运行 FastAPI，监听所有内网出口
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
