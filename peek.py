import docx
import sys

def peek_docx(path, num_paragraphs=50):
    try:
        doc = docx.Document(path)
        for i, para in enumerate(doc.paragraphs[:num_paragraphs]):
            text = para.text.strip()
            if text:
                print(f"[{i}]: {text}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    peek_docx("doc/HCIE-AI笔试_含答案1117.docx")
