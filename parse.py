import docx
import re
import json
import os

def parse_docx(path):
    if not os.path.exists(path):
        print(f"Error: {path} not found")
        return

    doc = docx.Document(path)
    
    questions = []
    current_q = None
    next_id = 1
    current_type = "单选题" # Default fallback

    for para in doc.paragraphs:
        full_text = para.text.strip()
        if not full_text: continue
        
        # 1. Flex Header Detection (e.g. "三、单选题", "填空题")
        header_match = re.search(r'(判断题|填空题|单选题|多选题)', full_text)
        # Headers are usually short and distinct
        if header_match and len(full_text) < 15: 
            current_type = header_match.group(1)
            continue
            
        # 2. Match question start like "3.在MoE模型中..." or "109.FabricInsight..."
        # Support both dot (.) and ideographic comma (、)
        m = re.match(r'^(\d+)\s*[\.、]\s*(.*)', full_text)
        if m:
            if current_q:
                current_q["id"] = next_id
                questions.append(current_q)
                next_id += 1
            current_q = {
                "type": current_type,
                "text": m.group(2).strip(),
                "options": [],
                "answer": []
            }
        else:
            if current_q:
                # Option or answer line
                is_answer = False
                clean_text = full_text
                
                # A. Check for inline answer tag like "(参考答案)" or "（参考答案）" or mixed/spaced
                ans_tag_match = re.search(r'[\(（]\s*参考答案\s*[\)）]', full_text)
                if ans_tag_match:
                    is_answer = True
                    # Strip the tag from the text
                    clean_text = full_text[:ans_tag_match.start()].strip() + full_text[ans_tag_match.end():].strip()
                
                # B. Check for block answer prefix like "参考答案：" (common for fill-in-the-blanks)
                if full_text.startswith("参考答案"):
                    is_answer = True
                    clean_text = re.sub(r'^参考答案[:：\s]*', '', full_text).strip()

                # C. Detect Option lines (A. xxx)
                opt_match = re.match(r'^([A-Z])\s*[\.、\s]\s*(.*)', clean_text)
                if opt_match:
                    opt_letter = opt_match.group(1)
                    current_q["options"].append(clean_text)
                    if is_answer:
                        current_q["answer"].append(opt_letter)
                else:
                    # If this is an answer but not an A-Z option, it might be a Fill-in-the-blank multi-answer or a T/F answer
                    if is_answer:
                        if current_q['type'] == '填空题':
                            # Split by common separators: commas, semicolons, ideographic commas, spaces
                            parts = re.split(r'[,，;；、\s]+', clean_text)
                            current_q["answer"].extend([p.strip().rstrip('；;.,，') for p in parts if p.strip()])
                        else:
                            # Likely a True/False answer or a fallback
                            current_q["answer"].append(clean_text)
                    else:
                        # Distinguish between T/F options and question text continuation
                        if full_text in ["对", "错", "正确", "错误"]:
                            current_q["options"].append(full_text)
                        elif "对" in full_text and "错" in full_text and len(full_text) < 10:
                            # Handles "A. 对 B. 错" or "对 错"
                            current_q["options"].extend(["对", "错"])
                        else:
                            # Append to question text if it's not a recognized option/answer
                            current_q["text"] += "\n" + full_text

    if current_q:
        questions.append(current_q)
        
    # --- Post-processing & Smart Categorization ---
    clean_questions = []
    anomalies = []
    
    for q in questions:
        # 1. Deduce correct type based on content
        # Check if it looks like a choice question
        has_letters = any(re.match(r'^[A-Z][\.、\s]', opt) for opt in q['options'])
        # Check if it looks like a true/false question
        has_tf_opts = any(opt in ["对", "错", "正确", "错误"] for opt in q['options'])
        has_tf_ans = any(ans in ["对", "错", "正确", "错误"] for ans in q['answer'])
        
        if has_letters:
            if len(q['answer']) > 1:
                q['type'] = "多选题"
            else:
                q['type'] = "单选题"
        elif has_tf_opts or has_tf_ans:
            q['type'] = "判断题"
            # Always force ["对", "错"] for judgment questions
            q['options'] = ["对", "错"]
        else:
            q['type'] = "填空题"

        # 2. Validation / Anomaly Detection
        issue = None
        if not q['text'].strip():
            issue = "题干为空"
        elif not q['answer']:
            issue = "缺少参考答案"
        elif q['type'] in ["单选题", "多选题"] and len(q['options']) < 2:
            issue = "选项不足"
        
        if issue:
            q['parse_error'] = issue
            anomalies.append(q)
        else:
            clean_questions.append(q)
            
    # Output results
    with open("questions.json", "w", encoding="utf-8") as f:
        json.dump(clean_questions, f, ensure_ascii=False, indent=2)
        
    with open("anomalies.json", "w", encoding="utf-8") as f:
        json.dump(anomalies, f, ensure_ascii=False, indent=2)
        
    print(f"--- Parsing Complete ---")
    print(f"Total parsed: {len(questions)}")
    print(f"Successfully cleaned: {len(clean_questions)}")
    print(f"Anomalies found: {len(anomalies)} (See anomalies.json)")
    
if __name__ == "__main__":
    parse_docx("doc/HCIE-AI笔试_含答案1117.docx")
