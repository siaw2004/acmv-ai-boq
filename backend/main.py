from typing import List
import re

import cv2
import numpy as np
import pytesseract
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware


# 改成你自己电脑的 Tesseract 安装路径
pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"

app = FastAPI(
    title="ACMV Matcher API",
    version="0.2.0",
    description="ACMV drawing detection backend: symbol matching + text label scan.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root():
    return {"message": "ACMV Matcher API is running"}


def read_upload_image(upload: UploadFile) -> np.ndarray:
    file_bytes = upload.file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Empty file uploaded.")

    np_bytes = np.frombuffer(file_bytes, dtype=np.uint8)
    image = cv2.imdecode(np_bytes, cv2.IMREAD_COLOR)

    if image is None:
        raise HTTPException(status_code=400, detail="Failed to decode image.")

    return image


def preprocess_line_drawing(image: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (3, 3), 0)

    _, bw = cv2.threshold(
        blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU
    )

    ink = 255 - bw

    kernel = np.ones((2, 2), np.uint8)
    ink = cv2.morphologyEx(ink, cv2.MORPH_OPEN, kernel)

    return ink


def crop_to_nonzero(binary_img: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    mask = np.where(binary_img > 0, 255, 0).astype(np.uint8)

    points = cv2.findNonZero(mask)
    if points is None:
        raise HTTPException(
            status_code=400,
            detail="Sample image has no detectable symbol pixels. Crop tighter.",
        )

    x, y, w, h = cv2.boundingRect(points)

    cropped_img = binary_img[y: y + h, x: x + w]
    cropped_mask = mask[y: y + h, x: x + w]

    if min(cropped_mask.shape[:2]) >= 12:
        cropped_mask = cv2.erode(
            cropped_mask, np.ones((2, 2), np.uint8), iterations=1
        )

    return cropped_img, cropped_mask


def iou(box_a, box_b) -> float:
    ax1, ay1, aw, ah = box_a
    bx1, by1, bw, bh = box_b

    ax2, ay2 = ax1 + aw, ay1 + ah
    bx2, by2 = bx1 + bw, by1 + bh

    inter_x1 = max(ax1, bx1)
    inter_y1 = max(ay1, by1)
    inter_x2 = min(ax2, bx2)
    inter_y2 = min(ay2, by2)

    inter_w = max(0, inter_x2 - inter_x1)
    inter_h = max(0, inter_y2 - inter_y1)
    inter_area = inter_w * inter_h

    area_a = aw * ah
    area_b = bw * bh
    union = area_a + area_b - inter_area

    if union <= 0:
        return 0.0

    return inter_area / union


def nms(candidates: List[dict], iou_threshold: float = 0.25) -> List[dict]:
    candidates = sorted(candidates, key=lambda x: x["score"], reverse=True)
    kept = []

    for cand in candidates:
        cand_box = (cand["x"], cand["y"], cand["w"], cand["h"])

        overlapped = False
        for kept_item in kept:
            kept_box = (
                kept_item["x"],
                kept_item["y"],
                kept_item["w"],
                kept_item["h"],
            )
            if iou(cand_box, kept_box) > iou_threshold:
                overlapped = True
                break

        if not overlapped:
            kept.append(cand)

    return kept


@app.post("/match-symbol")
def match_symbol(
    drawing: UploadFile = File(...),
    sample: UploadFile = File(...),
    item_name: str = Form(...),
    threshold: float = Form(0.62),
):
    try:
        if not drawing.content_type or not drawing.content_type.startswith("image/"):
            raise HTTPException(status_code=400, detail="Drawing must be an image file.")

        if not sample.content_type or not sample.content_type.startswith("image/"):
            raise HTTPException(status_code=400, detail="Sample must be an image file.")

        threshold = float(np.clip(threshold, 0.45, 0.95))

        drawing_img = read_upload_image(drawing)
        sample_img = read_upload_image(sample)

        max_side = 1400
        h, w = drawing_img.shape[:2]
        scale_ratio = min(1.0, max_side / max(h, w))

        if scale_ratio < 1.0:
            drawing_img = cv2.resize(
                drawing_img,
                (int(w * scale_ratio), int(h * scale_ratio)),
                interpolation=cv2.INTER_AREA,
            )

        drawing_bin = preprocess_line_drawing(drawing_img)
        sample_bin = preprocess_line_drawing(sample_img)

        templ, mask = crop_to_nonzero(sample_bin)

        search_h, search_w = drawing_bin.shape[:2]
        templ_h, templ_w = templ.shape[:2]

        if templ_h < 8 or templ_w < 8:
            raise HTTPException(status_code=400, detail="Sample too small. Crop a bit larger.")

        max_template_side = 120
        template_scale = min(1.0, max_template_side / max(templ_h, templ_w))
        if template_scale < 1.0:
            templ = cv2.resize(
                templ,
                (int(templ_w * template_scale), int(templ_h * template_scale)),
                interpolation=cv2.INTER_NEAREST,
            )
            mask = cv2.resize(
                mask,
                (int(templ_w * template_scale), int(templ_h * template_scale)),
                interpolation=cv2.INTER_NEAREST,
            )
            _, mask = cv2.threshold(mask, 127, 255, cv2.THRESH_BINARY)

        templ_h, templ_w = templ.shape[:2]

        templ = templ.astype(np.uint8)
        mask = mask.astype(np.uint8)
        drawing_bin = drawing_bin.astype(np.uint8)

        scale_factors = [0.9, 1.0, 1.1]
        raw_candidates = []

        for scale in scale_factors:
            scaled_w = max(8, int(templ_w * scale))
            scaled_h = max(8, int(templ_h * scale))

            if scaled_w >= search_w or scaled_h >= search_h:
                continue

            scaled_templ = cv2.resize(
                templ, (scaled_w, scaled_h), interpolation=cv2.INTER_NEAREST
            )
            scaled_mask = cv2.resize(
                mask, (scaled_w, scaled_h), interpolation=cv2.INTER_NEAREST
            )
            _, scaled_mask = cv2.threshold(scaled_mask, 127, 255, cv2.THRESH_BINARY)

            scaled_templ = scaled_templ.astype(np.uint8)
            scaled_mask = scaled_mask.astype(np.uint8)

            result = cv2.matchTemplate(
                drawing_bin,
                scaled_templ,
                cv2.TM_CCORR_NORMED,
                mask=scaled_mask,
            )

            ys, xs = np.where(result >= threshold)

            max_hits_per_scale = 200
            hit_count = 0

            for x, y in zip(xs, ys):
                raw_candidates.append(
                    {
                        "x": int(x),
                        "y": int(y),
                        "w": int(scaled_w),
                        "h": int(scaled_h),
                        "score": float(result[y, x]),
                    }
                )
                hit_count += 1
                if hit_count >= max_hits_per_scale:
                    break

        if not raw_candidates:
            return {
                "item_name": item_name,
                "count": 0,
                "used_threshold": threshold,
                "drawing_scale_ratio": scale_ratio,
                "detections": [],
            }

        final_detections = nms(raw_candidates, iou_threshold=0.22)

        return {
            "item_name": item_name,
            "count": len(final_detections),
            "used_threshold": threshold,
            "drawing_scale_ratio": scale_ratio,
            "detections": final_detections[:80],
        }

    except HTTPException:
        raise
    except Exception as e:
        print("=== MATCH_SYMBOL ERROR ===")
        print(repr(e))
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/scan-text-labels")
def scan_text_labels(
    drawing: UploadFile = File(...),
    keywords: str = Form(...),
):
    try:
        if not drawing.content_type or not drawing.content_type.startswith("image/"):
            raise HTTPException(status_code=400, detail="Drawing must be an image file.")

        drawing_img = read_upload_image(drawing)

        max_side = 1800
        h, w = drawing_img.shape[:2]
        scale_ratio = min(1.0, max_side / max(h, w))
        if scale_ratio < 1.0:
            drawing_img = cv2.resize(
                drawing_img,
                (int(w * scale_ratio), int(h * scale_ratio)),
                interpolation=cv2.INTER_AREA,
            )

        gray = cv2.cvtColor(drawing_img, cv2.COLOR_BGR2GRAY)
        blur = cv2.GaussianBlur(gray, (3, 3), 0)

        _, thresh = cv2.threshold(
            blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU
        )

        ocr_config = r"--oem 3 --psm 11"
        text = pytesseract.image_to_string(thresh, config=ocr_config)
        upper_text = text.upper()

        keyword_list = [
            kw.strip().upper()
            for kw in keywords.split(",")
            if kw.strip()
        ]

        results = {}
        for kw in keyword_list:
            pattern = rf"\b{re.escape(kw)}\b"
            matches = re.findall(pattern, upper_text)
            results[kw] = len(matches)

        return {
            "keywords": keyword_list,
            "counts": results,
            "raw_text": text[:5000],
            "drawing_scale_ratio": scale_ratio,
        }

    except HTTPException:
        raise
    except Exception as e:
        print("=== SCAN_TEXT_LABELS ERROR ===")
        print(repr(e))
        raise HTTPException(status_code=500, detail=str(e))