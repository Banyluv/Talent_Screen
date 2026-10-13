"""CV file-type detection and text extraction.

The TypeScript engine used pdfjs-dist and mammoth; this port uses pypdf and
python-docx (imported lazily so the rest of the engine stays dependency-free)
and then applies exactly the same text post-processing.
"""
from __future__ import annotations

import io
import re

ACCEPTED: dict[str, str] = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "text/plain": "txt",
}

# pdfjs read at most 30 pages; keep the same cap.
_MAX_PAGES = 30


class UnreadableCvError(Exception):
    pass


def detect_type(file_name: str, mime: str, buf: bytes) -> str | None:
    """Decide the file type from extension AND content; never trust the client-supplied MIME type alone."""
    ext = file_name.lower().split(".")[-1]
    if ext == "pdf":
        return "pdf" if buf[:5].decode("latin-1") == "%PDF-" else None
    if ext == "docx":
        return "docx" if len(buf) > 1 and buf[0] == 0x50 and buf[1] == 0x4B else None  # ZIP container
    if ext == "txt":
        return None if b"\x00" in buf else "txt"  # binary data is not text
    return None


def _pdf_text(buf: bytes) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as e:  # pragma: no cover - depends on the environment
        raise RuntimeError("pypdf is required to read PDF CVs (pip install pypdf)") from e

    reader = PdfReader(io.BytesIO(buf))
    out = ""
    for p in range(min(len(reader.pages), _MAX_PAGES)):
        page = reader.pages[p]
        parts: list[str] = []
        state: dict[str, float | None] = {"y": None}

        def visit(text: str, cm, tm, font_dict, font_size) -> None:
            y = tm[5] if tm is not None and len(tm) > 5 else None
            if (
                state["y"] is not None
                and y is not None
                and abs(y - state["y"]) > 2
                and parts
                and not parts[-1].endswith("\n")
            ):
                parts.append("\n")
            parts.append(text)
            if y is not None:
                state["y"] = y

        page.extract_text(visitor_text=visit)
        out += "".join(parts) + "\n"
    return out


def _docx_text(buf: bytes) -> str:
    try:
        import docx
        from docx.table import Table
        from docx.text.paragraph import Paragraph
    except ImportError as e:  # pragma: no cover - depends on the environment
        raise RuntimeError("python-docx is required to read DOCX CVs (pip install python-docx)") from e

    document = docx.Document(io.BytesIO(buf))
    parts: list[str] = []
    for child in document.element.body.iterchildren():
        tag = child.tag.rsplit("}", 1)[-1]
        if tag == "p":
            parts.append(Paragraph(child, document).text)
        elif tag == "tbl":
            for row in Table(child, document).rows:
                parts.append("\n".join(cell.text for cell in row.cells))
    return "\n\n".join(parts)


def extract_text(buf: bytes, type_: str) -> str:
    if type_ == "pdf":
        text = _pdf_text(buf)
    elif type_ == "docx":
        text = _docx_text(buf)
    else:
        text = buf.decode("utf-8", errors="replace")
    text = text.replace("\r", "").replace("\u00a0", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if len(re.sub(r"[\s\ufeff]", "", text)) < 80:
        raise UnreadableCvError(
            "No readable text in this PDF. It is probably a scanned image; run OCR or upload a text-based copy."
            if type_ == "pdf"
            else "The file contains too little text to be a CV."
        )
    return text
