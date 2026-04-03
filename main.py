import json
import sqlite3
import os
import requests
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional

app = FastAPI(title="答题宝 (Exam Prep API)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_DIR = "data"
if not os.path.exists(DB_DIR):
    os.makedirs(DB_DIR)
DB_PATH = os.path.join(DB_DIR, "data.db")
QUESTIONS_FILE = "questions.json"

def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    # Key-value store for app settings (like API key, practice progress)
    c.execute('''CREATE TABLE IF NOT EXISTS settings
                 (key TEXT PRIMARY KEY, value TEXT)''')
    # Track which questions are answered and if they were correct
    c.execute('''CREATE TABLE IF NOT EXISTS records
                 (question_id INTEGER PRIMARY KEY, is_correct INTEGER, selected_answer TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)''')
    # Track wrong questions specifically for the review mode
    c.execute('''CREATE TABLE IF NOT EXISTS wrong_book
                 (question_id INTEGER PRIMARY KEY, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)''')
    # Track exam history records
    c.execute('''CREATE TABLE IF NOT EXISTS exam_history
                 (id INTEGER PRIMARY KEY AUTOINCREMENT, score INTEGER, correct_count INTEGER, total_count INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)''')
    # AI Explanation Cache
    c.execute('''CREATE TABLE IF NOT EXISTS ai_cache
                 (question_id INTEGER PRIMARY KEY, explanation TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)''')
    conn.commit()
    conn.close()

init_db()

def get_questions():
    if not os.path.exists(QUESTIONS_FILE):
        return []
    with open(QUESTIONS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)

# Models
class RecordPydantic(BaseModel):
    question_id: int
    is_correct: bool
    selected_answer: str

class ExamRecordPydantic(BaseModel):
    score: int
    correct_count: int
    total_count: int

class SettingModel(BaseModel):
    key: str
    value: str

class AIMessageReq(BaseModel):
    question: dict
    user_answer: str
    force: Optional[bool] = False

# API Routes
@app.get("/api/questions")
def read_questions():
    return get_questions()

@app.get("/api/settings/{key}")
def get_setting(key: str):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT value FROM settings WHERE key=?", (key,))
    row = c.fetchone()
    conn.close()
    return {"value": row[0] if row else ""}

@app.post("/api/settings")
def save_setting(req: SettingModel):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("REPLACE INTO settings (key, value) VALUES (?, ?)", (req.key, req.value))
    conn.commit()
    conn.close()
    return {"success": True}

@app.get("/api/records")
def get_records():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT question_id, is_correct, selected_answer FROM records")
    rows = c.fetchall()
    conn.close()
    return {
        "records": {row[0]: bool(row[1]) for row in rows},
        "answers": {row[0]: row[2] for row in rows}
    }

@app.post("/api/records")
def save_record(req: RecordPydantic):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("REPLACE INTO records (question_id, is_correct, selected_answer) VALUES (?, ?, ?)", 
              (req.question_id, 1 if req.is_correct else 0, req.selected_answer))
    if not req.is_correct:
        c.execute("INSERT OR IGNORE INTO wrong_book (question_id) VALUES (?)", (req.question_id,))
    conn.commit()
    conn.close()
    return {"success": True}

@app.get("/api/wrong_book")
def get_wrong_book():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT question_id FROM wrong_book")
    rows = c.fetchall()
    conn.close()
    return {"wrong_ids": [r[0] for r in rows]}

@app.delete("/api/wrong_book/{q_id}")
def remove_wrong_book(q_id: int):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("DELETE FROM wrong_book WHERE question_id=?", (q_id,))
    conn.commit()
    conn.close()
    return {"success": True}

@app.post("/api/reset_records")
def reset_records():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("DELETE FROM records")
    c.execute("DELETE FROM wrong_book")
    c.execute("DELETE FROM exam_history")
    c.execute("DELETE FROM settings WHERE key='practice_progress'") # Reset progress
    conn.commit()
    conn.close()
    return {"success": True}

@app.get("/api/exam_records")
def get_exam_records():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT id, score, correct_count, total_count, timestamp FROM exam_history ORDER BY id DESC")
    rows = c.fetchall()
    conn.close()
    return {"history": [{"id": r[0], "score": r[1], "correct": r[2], "total": r[3], "time": r[4]} for r in rows]}

@app.post("/api/exam_records")
def save_exam_record(req: ExamRecordPydantic):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("INSERT INTO exam_history (score, correct_count, total_count) VALUES (?, ?, ?)", 
              (req.score, req.correct_count, req.total_count))
    conn.commit()
    conn.close()
    return {"success": True}

@app.post("/api/llm/explain")
def get_llm_explanation(req: AIMessageReq):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT value FROM settings WHERE key='dashscope_api_key'")
    row = c.fetchone()
    
    q_id = req.question.get('id')
    
    # Check Cache
    if not req.force:
        c.execute("SELECT explanation FROM ai_cache WHERE question_id=?", (q_id,))
        cache_row = c.fetchone()
        if cache_row:
            conn.close()
            def gen_cache():
                yield " [来自缓存] "
                yield cache_row[0]
            return StreamingResponse(gen_cache(), media_type="text/event-stream")
    
    conn.close()
    
    api_key = row[0] if row else None
    if not api_key:
        return JSONResponse(status_code=400, content={"error": "请先在设置中配置大模型 API Key（DashScope）哦~"})
        
    prompt = f"""
请作为AI辅导老师，为我解析这道考试题。
解析要求：
1. **核心考点**：简述本题涉及的技术及原理。
2. **正解分析**：详细解析为什么正确选项是符合逻辑的。
3. **避坑指南**：解释为什么其他选项错误，或者指出容易混淆的知识点。
要求内容充实、逻辑严密，控制在3-5句话以内，不要废话，但要确保学生能听懂并记住。

题目信息：
题型：{req.question.get('type')}
题目：{req.question.get('text')}
选项：{json.dumps(req.question.get('options', []), ensure_ascii=False)}
正确答案：{req.question.get('answer')}
我的回答：{req.user_answer}
"""
    
    def generate():
        full_content = []
        try:
            with requests.post(
                "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json"
                },
                json={
                    "model": "qwen-max",
                    "messages": [
                        {"role": "system", "content": "你是一位耐心、专业的AI辅导老师。"},
                        {"role": "user", "content": prompt}
                    ],
                    "stream": True 
                },
                stream=True,
                timeout=30
            ) as resp:
                if resp.status_code != 200:
                    yield f"API Error: {resp.status_code} - {resp.text}"
                    return

                for line in resp.iter_lines():
                    if line:
                        line_str = line.decode('utf-8')
                        if line_str.startswith("data: "):
                            data_content = line_str[6:]
                            if data_content == "[DONE]":
                                break
                            try:
                                chunk_json = json.loads(data_content)
                                if "choices" in chunk_json:
                                    delta = chunk_json["choices"][0].get("delta", {})
                                    content = delta.get("content", "")
                                    if content:
                                        full_content.append(content)
                                        yield content
                            except:
                                continue
            
            # Save to Cache
            if full_content:
                c_conn = sqlite3.connect(DB_PATH)
                cc = c_conn.cursor()
                final_text = "".join(full_content)
                cc.execute("REPLACE INTO ai_cache (question_id, explanation) VALUES (?, ?)", (q_id, final_text))
                c_conn.commit()
                c_conn.close()

        except Exception as e:
            yield f"Streaming Error: {str(e)}"

    return StreamingResponse(generate(), media_type="text/event-stream")

# Mount frontend
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
